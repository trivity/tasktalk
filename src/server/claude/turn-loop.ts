import type Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { MAX_TURN_ITERATIONS } from './client.js';
import { getAiClientForUser, type AiClientHandle } from './get-client.js';
import { ANTHROPIC_TOOLS, WRITE_TOOL_NAMES } from './tools-registry.js';
import { executeTool, type ExecuteToolResult } from './execute-tool.js';
import { buildPreview } from './preview.js';
import { TurnMcpPool } from '../mcp/client.js';
import { db } from '../db/client.js';
import { messages, toolCalls, cuWorkspaces, pendingWrites } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { buildSystemPrompt } from './system-prompt.js';
import { bumpLastMessageAt } from '../db/queries/conversations.js';

export type TurnEvent =
  | { type: 'message_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; tool_name: string; tool_use_id: string }
  | { type: 'tool_use_complete'; tool_use_id: string; router_path: string; latency_ms: number; ok: boolean }
  | { type: 'needs_confirmation'; tool_use_id: string; tool_name: string; confirmation_token: string; preview: unknown }
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

  // 0. resolve per-user (or env-fallback) AI client
  let ai: AiClientHandle;
  try {
    ai = await getAiClientForUser(opts.userId);
  } catch (e) {
    await opts.emit({ type: 'error', error: 'AI provider not configured. Set your Anthropic API key in Settings.' });
    return;
  }

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
      const stream = ai.client.messages.stream({
        model: ai.model,
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

      // partition into reads vs writes — writes pause the turn for user confirmation
      const reads = pendingToolUses.filter((tu) => !WRITE_TOOL_NAMES.has(tu.name));
      const writes = pendingToolUses.filter((tu) => WRITE_TOOL_NAMES.has(tu.name));

      // execute reads as before (they don't need confirmation)
      const toolResultsBlock: Anthropic.MessageParam = { role: 'user', content: [] };
      for (const tu of reads) {
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

      // for each write, build preview, mint token, persist pending_writes, and emit needs_confirmation
      for (const tu of writes) {
        let preview: unknown;
        try {
          preview = await buildPreview({ workspaceId: opts.workspaceId, toolName: tu.name, args: tu.input });
        } catch (e) {
          const errMsg = String((e as Error).message ?? e);
          (toolResultsBlock.content as any[]).push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: `preview_error: ${errMsg}`,
            is_error: true,
          });
          continue;
        }
        const token = randomUUID();
        await db.insert(pendingWrites).values({
          confirmationToken: token,
          userId: opts.userId,
          conversationId: opts.conversationId,
          toolUseId: tu.id,
          toolName: tu.name,
          args: tu.input,
          preview,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        });
        await opts.emit({ type: 'needs_confirmation', tool_use_id: tu.id, tool_name: tu.name, confirmation_token: token, preview });
      }

      // if any writes were proposed, end the turn here. The confirm-write route will resume.
      if (writes.length > 0) {
        const allToolUses = [
          ...collectedToolUses.map((t) => ({ id: t.id, name: t.name, input: t.input })),
          ...writes.map((w) => ({ id: w.id, name: w.name, input: w.input })),
        ];
        const [m] = await db.insert(messages).values({
          conversationId: opts.conversationId,
          role: 'assistant',
          content: { text: assistantTextBuffer, tool_uses: allToolUses },
        }).returning();
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

      // no writes — append results and continue loop
      apiMessages.push({ role: 'assistant', content: finalMessage.content });
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
