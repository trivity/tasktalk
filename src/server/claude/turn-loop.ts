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
import { eq, inArray, sql } from 'drizzle-orm';
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
  workspaceIds: string[];
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

  const wsRows = opts.workspaceIds.length > 0
    ? await db.select().from(cuWorkspaces).where(inArray(cuWorkspaces.workspaceId, opts.workspaceIds))
    : [];
  // Pick the OLDEST last_incremental_sync_at across workspaces — worst-case staleness.
  const oldestSync = wsRows.reduce<Date>((acc, r) => {
    const t = r.lastIncrementalSyncAt ?? new Date(0);
    return t.getTime() < acc.getTime() ? t : acc;
  }, new Date());
  const taskCountRow = opts.workspaceIds.length > 0
    ? await db.execute(sql`SELECT COUNT(*)::int AS c FROM cu_tasks WHERE workspace_id = ANY(${opts.workspaceIds})`)
    : [];
  const taskCount = Number(((taskCountRow as unknown as Array<{ c: number }>)[0]?.c ?? 0));

  const systemPrompt = buildSystemPrompt({
    userName: opts.userName,
    userEmail: opts.userEmail,
    workspaceName: opts.workspaceName,
    workspaceCount: opts.workspaceIds.length,
    mirrorAsOf: wsRows.length > 0 ? oldestSync : new Date(0),
    taskCount,
    now: new Date(),
  });

  // 3. loop
  const apiMessages: Anthropic.MessageParam[] = history.flatMap((m) => toApiMessages(m));

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
        // persist assistant message + close. Include `result` per tool_use so the
        // history reconstruction (toApiMessages) can emit valid tool_result blocks
        // for follow-up turns. Without this, Claude rejects the next turn with
        // "tool_use ids must be followed by tool_result blocks".
        const [m] = await db.insert(messages).values({ conversationId: opts.conversationId, role: 'assistant', content: { text: assistantTextBuffer, tool_uses: collectedToolUses.map((t) => ({ id: t.id, name: t.name, input: t.input, result: t.result.ok ? t.result.result : { error: t.result.error } })) } }).returning();
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
        const result = await executeTool({ name: tu.name, args: tu.input, workspaceIds: opts.workspaceIds, pool });
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
          preview = await buildPreview({ workspaceIds: opts.workspaceIds, toolName: tu.name, args: tu.input });
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
          ...collectedToolUses.map((t) => ({ id: t.id, name: t.name, input: t.input, result: t.result.ok ? t.result.result : { error: t.result.error } })),
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

type StoredToolUse = { id: string; name: string; input: Record<string, unknown>; result?: unknown };
type StoredAssistantContent = { text?: string; tool_uses?: StoredToolUse[] };
type StoredToolMessageContent = { tool_use_id?: string; ok?: boolean; result?: unknown; error?: string | null; status?: string };

/**
 * Translate a persisted message to one or more Anthropic API messages.
 *
 * For assistant messages that ended with tool_use blocks, Anthropic's API requires
 * the next message to be a user message containing matching tool_result blocks.
 * Read tools' results are stored on the tool_use itself (per-result above); write
 * tools' results arrive in subsequent role='tool' messages from the confirm-write
 * route. We synthesize the tool_result follow-up here from whichever source has it.
 */
function toApiMessages(m: { role: string; content: unknown }): Anthropic.MessageParam[] {
  if (m.role === 'user') {
    const c = m.content as { text?: string } | undefined;
    return [{ role: 'user', content: c?.text ?? '' }];
  }

  if (m.role === 'assistant') {
    const c = m.content as StoredAssistantContent | undefined;
    return [...assistantToApi(c)];
  }

  if (m.role === 'tool') {
    // Tool-result message inserted by the confirm-write or undo route.
    const c = m.content as StoredToolMessageContent | undefined;
    if (!c?.tool_use_id) return [];
    const payload = c.status === 'denied'
      ? 'user_denied'
      : c.ok === false
        ? `error: ${c.error ?? 'unknown'}`
        : JSON.stringify(c.result ?? {});
    return [{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: c.tool_use_id, content: payload, is_error: c.ok === false } as Anthropic.ToolResultBlockParam],
    }];
  }

  // system_event and unknown roles are not part of Claude's view of the conversation.
  return [];
}

function assistantToApi(c: StoredAssistantContent | undefined): Anthropic.MessageParam[] {
  const blocks: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = [];
  if (c?.text) blocks.push({ type: 'text', text: c.text });
  for (const tu of c?.tool_uses ?? []) blocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
  if (blocks.length === 0) return [{ role: 'assistant', content: c?.text ?? '' }];
  const out: Anthropic.MessageParam[] = [{ role: 'assistant', content: blocks }];

  // If any tool_use carries an inline `result` (read tools record this on persist),
  // emit a synthetic tool_result follow-up. Tool_uses without a stored result are
  // expected to be paired with a separate role='tool' message immediately after.
  const inlineResults = (c?.tool_uses ?? []).filter((tu) => tu.result !== undefined);
  if (inlineResults.length > 0) {
    out.push({
      role: 'user',
      content: inlineResults.map((tu) => {
        const isErr = !!(tu.result && typeof tu.result === 'object' && (tu.result as { error?: string }).error);
        return {
          type: 'tool_result',
          tool_use_id: tu.id,
          content: typeof tu.result === 'string' ? tu.result : JSON.stringify(tu.result),
          is_error: isErr,
        } as Anthropic.ToolResultBlockParam;
      }),
    });
  }

  return out;
}
