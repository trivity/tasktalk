import type Anthropic from '@anthropic-ai/sdk';
import { anthropic, CLAUDE_MODEL, MAX_TURN_ITERATIONS } from './client.js';
import { ANTHROPIC_TOOLS } from './tools-registry.js';
import { executeTool, type ExecuteToolResult } from './execute-tool.js';
import { TurnMcpPool } from '../mcp/client.js';
import { db } from '../db/client.js';
import { messages, toolCalls, cuWorkspaces } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { buildSystemPrompt } from './system-prompt.js';
import { bumpLastMessageAt } from '../db/queries/conversations.js';

export type TurnEvent =
  | { type: 'message_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; tool_name: string; tool_use_id: string }
  | { type: 'tool_use_complete'; tool_use_id: string; router_path: string; latency_ms: number; ok: boolean }
  | { type: 'message_complete' }
  | { type: 'error'; error: string };

export async function runTurn(opts: {
  userId: string;
  conversationId: string;
  userText: string;
  userName: string | null;
  userEmail: string;
  workspaceId: string;
  workspaceName: string;
  emit: (event: TurnEvent) => Promise<void> | void;
}): Promise<void> {
  const pool = new TurnMcpPool(opts.userId);

  // 1. persist user message
  await db.insert(messages).values({ conversationId: opts.conversationId, role: 'user', content: { text: opts.userText } });
  await bumpLastMessageAt(opts.conversationId);

  // 2. build context
  const history = await db.select().from(messages)
    .where(eq(messages.conversationId, opts.conversationId))
    .orderBy(messages.createdAt);

  const [ws] = await db.select().from(cuWorkspaces).where(eq(cuWorkspaces.workspaceId, opts.workspaceId)).limit(1);
  const taskCountRow = await db.execute(sql`SELECT COUNT(*)::int AS c FROM cu_tasks WHERE workspace_id = ${opts.workspaceId}`);
  const taskCount = Number(((taskCountRow as unknown as Array<{ c: number }>)[0]?.c ?? 0));

  const systemPrompt = buildSystemPrompt({
    userName: opts.userName,
    userEmail: opts.userEmail,
    workspaceName: opts.workspaceName,
    mirrorAsOf: ws?.lastIncrementalSyncAt ?? new Date(0),
    taskCount,
    now: new Date(),
  });

  // 3. loop
  const apiMessages: Anthropic.MessageParam[] = history.map((m) => toApiMessage(m));

  await opts.emit({ type: 'message_start' });
  let assistantMsgId: string | null = null;
  let assistantTextBuffer = '';
  const collectedToolUses: Array<{ id: string; name: string; input: Record<string, unknown>; result: ExecuteToolResult }> = [];

  try {
    for (let iter = 0; iter < MAX_TURN_ITERATIONS; iter++) {
      const stream = anthropic.messages.stream({
        model: CLAUDE_MODEL,
        max_tokens: 2048,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }] as any,
        tools: ANTHROPIC_TOOLS,
        messages: apiMessages,
      });

      const pendingToolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
      let textInThisIteration = '';

      stream.on('text', async (delta) => {
        textInThisIteration += delta;
        await opts.emit({ type: 'text_delta', text: delta });
      });

      const finalMessage = await stream.finalMessage();
      assistantTextBuffer += textInThisIteration;

      for (const block of finalMessage.content) {
        if (block.type === 'tool_use') {
          pendingToolUses.push({ id: block.id, name: block.name, input: (block.input as Record<string, unknown>) ?? {} });
        }
      }

      if (finalMessage.stop_reason === 'end_turn' || pendingToolUses.length === 0) {
        // persist assistant message + close
        const [m] = await db.insert(messages).values({ conversationId: opts.conversationId, role: 'assistant', content: { text: assistantTextBuffer, tool_uses: collectedToolUses.map((t) => ({ id: t.id, name: t.name, input: t.input })) } }).returning();
        assistantMsgId = m!.id;
        for (const tu of collectedToolUses) {
          await db.insert(toolCalls).values({
            messageId: assistantMsgId,
            toolName: tu.name,
            args: tu.input,
            result: tu.result.ok ? (tu.result.result as Record<string, unknown> | unknown) : { error: tu.result.error },
            routerPath: tu.result.routerPath,
            latencyMs: tu.result.latencyMs,
          });
        }
        await opts.emit({ type: 'message_complete' });
        return;
      }

      // execute tools and append results to apiMessages, then continue loop
      apiMessages.push({ role: 'assistant', content: finalMessage.content });
      const toolResultsBlock: Anthropic.MessageParam = { role: 'user', content: [] };
      for (const tu of pendingToolUses) {
        await opts.emit({ type: 'tool_use_start', tool_name: tu.name, tool_use_id: tu.id });
        const result = await executeTool({ name: tu.name, args: tu.input, workspaceId: opts.workspaceId, pool });
        await opts.emit({ type: 'tool_use_complete', tool_use_id: tu.id, router_path: result.routerPath, latency_ms: result.latencyMs, ok: result.ok });
        collectedToolUses.push({ id: tu.id, name: tu.name, input: tu.input, result });
        (toolResultsBlock.content as any[]).push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: result.ok ? JSON.stringify(result.result) : `error: ${result.error}`,
          is_error: !result.ok,
        });
      }
      apiMessages.push(toolResultsBlock);
    }

    // hit iteration cap
    assistantTextBuffer += '\n\n(Reached the tool-use iteration cap; let me know how to simplify.)';
    const [m] = await db.insert(messages).values({ conversationId: opts.conversationId, role: 'assistant', content: { text: assistantTextBuffer } }).returning();
    assistantMsgId = m!.id;
    await opts.emit({ type: 'message_complete' });
  } catch (err) {
    await opts.emit({ type: 'error', error: String((err as Error).message ?? err) });
  } finally {
    await pool.closeAll();
  }
}

function toApiMessage(m: { role: string; content: unknown }): Anthropic.MessageParam {
  const c = m.content as { text?: string; tool_uses?: Array<{ id: string; name: string; input: Record<string, unknown> }> } | undefined;
  if (m.role === 'user') return { role: 'user', content: c?.text ?? '' };
  if (m.role === 'assistant') {
    const blocks: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = [];
    if (c?.text) blocks.push({ type: 'text', text: c.text });
    for (const tu of c?.tool_uses ?? []) blocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
    return { role: 'assistant', content: blocks.length ? blocks : (c?.text ?? '') };
  }
  // 'tool' and 'system_event' messages don't go to Claude history directly; skip by collapsing to user note
  return { role: 'user', content: JSON.stringify(m.content) };
}
