import type Anthropic from '@anthropic-ai/sdk';
import { db } from '../db/client.js';
import { routines, routineRuns, messages, clickupConnections, cuWorkspaces, users } from '../db/schema.js';
import { and, eq, isNull } from 'drizzle-orm';
import { MAX_TURN_ITERATIONS } from '../claude/client.js';
import { getAiClientForUser } from '../claude/get-client.js';
import { ANTHROPIC_TOOLS, READ_ONLY_TOOL_NAMES } from '../claude/tools-registry.js';
import { executeTool } from '../claude/execute-tool.js';
import { TurnMcpPool } from '../mcp/client.js';
import { buildSystemPrompt } from '../claude/system-prompt.js';
import { bumpLastMessageAt } from '../db/queries/conversations.js';
import { computeNextRun } from './schedule-utils.js';
import { sendRoutineReport } from './email.js';

/**
 * Execute a routine. Headless variant of turn-loop:
 * - No streaming (uses messages.create)
 * - Read tools only — write tool calls return an error to the model
 * - No conversation history fed to the model (each run starts fresh)
 * - Persists user prompt + final assistant message in routine's pinned
 *   conversation so the user can browse history in the chat sidebar
 * - Sends email via Resend when deliver_email is enabled
 */
export async function executeRoutine(routineId: string): Promise<void> {
  const [routine] = await db.select().from(routines).where(eq(routines.id, routineId)).limit(1);
  if (!routine) throw new Error(`routine ${routineId} not found`);

  const [runRow] = await db
    .insert(routineRuns)
    .values({ routineId, status: 'running' })
    .returning();
  const runId = runRow!.id;

  try {
    const responseText = await runHeadlessTurn(routine);

    await db
      .update(routineRuns)
      .set({ status: 'done', finishedAt: new Date(), responseText })
      .where(eq(routineRuns.id, runId));
    await db
      .update(routines)
      .set({
        lastRunAt: new Date(),
        nextRunAt: computeNextRun(routine.schedule, routine.timezone, new Date()),
      })
      .where(eq(routines.id, routineId));

    if (routine.deliverEmail) {
      const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, routine.userId)).limit(1);
      const to = routine.emailTo ?? u?.email;
      if (to) {
        const result = await sendRoutineReport({
          to,
          subject: `[Tasktalk] ${routine.name}`,
          markdown: responseText,
        });
        if (!result.ok) {
          console.error('[routines] email send failed', { routineId, error: result.error });
        }
      }
    }
  } catch (err) {
    const errorMessage = String((err as Error).message ?? err);
    await db
      .update(routineRuns)
      .set({ status: 'error', finishedAt: new Date(), errorMessage })
      .where(eq(routineRuns.id, runId));
    await db
      .update(routines)
      .set({
        lastRunAt: new Date(),
        nextRunAt: computeNextRun(routine.schedule, routine.timezone, new Date()),
      })
      .where(eq(routines.id, routineId));
    console.error('[routines] execution failed', { routineId, errorMessage });
  }
}

async function runHeadlessTurn(routine: typeof routines.$inferSelect): Promise<string> {
  // Resolve workspaces for the routine owner
  const wsConns = await db
    .select({ workspaceId: clickupConnections.workspaceId })
    .from(clickupConnections)
    .where(and(eq(clickupConnections.userId, routine.userId), isNull(clickupConnections.tombstonedAt)));
  const workspaceIds = wsConns.map((r) => r.workspaceId).filter((id) => !id.startsWith('pending-'));

  const [u] = await db.select().from(users).where(eq(users.id, routine.userId)).limit(1);
  if (!u) throw new Error('routine owner missing');

  const ai = await getAiClientForUser(routine.userId);

  const wsRows = workspaceIds.length > 0
    ? await db.select().from(cuWorkspaces).where(eq(cuWorkspaces.workspaceId, workspaceIds[0]!))
    : [];
  const workspaceName = wsRows[0]?.name ?? 'Workspace';
  const oldestSync = workspaceIds.length > 0 ? new Date() : new Date(0);
  const taskCount = 0; // not critical for routines; keep prompt small

  const systemPromptBase = buildSystemPrompt({
    userName: u.name,
    userEmail: u.email,
    workspaceName,
    workspaceCount: workspaceIds.length,
    mirrorAsOf: oldestSync,
    taskCount,
    now: new Date(),
  });
  const systemPrompt = `${systemPromptBase}\n\n## Scheduled-routine context\n- This is a scheduled run, not an interactive chat. Produce a complete report.\n- Do NOT ask follow-up questions. Do NOT propose write tools — they are disabled here.\n- Skip the SUGGESTED_NEXT line. The output is going to a report.`;

  // Persist the user prompt for the conversation history view.
  await db.insert(messages).values({
    conversationId: routine.conversationId,
    role: 'user',
    content: { text: routine.prompt },
  });
  await bumpLastMessageAt(routine.conversationId);

  // Headless turn loop (read tools only).
  const pool = new TurnMcpPool(routine.userId);
  const apiMessages: Anthropic.MessageParam[] = [{ role: 'user', content: routine.prompt }];
  const collectedToolUses: Array<{ id: string; name: string; input: Record<string, unknown>; result: unknown }> = [];
  let assistantText = '';

  try {
    for (let iter = 0; iter < MAX_TURN_ITERATIONS; iter++) {
      const finalMessage = await ai.client.messages.create({
        model: ai.model,
        max_tokens: 2048,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }] as any,
        tools: ANTHROPIC_TOOLS,
        messages: apiMessages,
      });

      let textInThisIteration = '';
      const pendingToolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
      for (const block of finalMessage.content) {
        if (block.type === 'text') textInThisIteration += block.text;
        if (block.type === 'tool_use') {
          pendingToolUses.push({ id: block.id, name: block.name, input: (block.input as Record<string, unknown>) ?? {} });
        }
      }
      assistantText += textInThisIteration;

      if (finalMessage.stop_reason === 'end_turn' || pendingToolUses.length === 0) {
        break;
      }

      const toolResultsBlock: Anthropic.MessageParam = { role: 'user', content: [] };
      for (const tu of pendingToolUses) {
        if (!READ_ONLY_TOOL_NAMES.has(tu.name)) {
          (toolResultsBlock.content as any[]).push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: 'error: write tools (create/update/delete/comment) are disabled in scheduled routines',
            is_error: true,
          });
          collectedToolUses.push({ id: tu.id, name: tu.name, input: tu.input, result: { error: 'write_disabled_in_routines' } });
          continue;
        }
        const result = await executeTool({ name: tu.name, args: tu.input, workspaceIds, pool });
        const payload = result.ok ? JSON.stringify(result.result) : `error: ${result.error}`;
        (toolResultsBlock.content as any[]).push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: payload,
          is_error: !result.ok,
        });
        collectedToolUses.push({ id: tu.id, name: tu.name, input: tu.input, result: result.ok ? result.result : { error: result.error } });
      }

      apiMessages.push({ role: 'assistant', content: finalMessage.content });
      apiMessages.push(toolResultsBlock);
    }
  } finally {
    await pool.closeAll();
  }

  if (!assistantText) assistantText = '(empty response)';

  // Persist assistant message for the conversation view.
  await db.insert(messages).values({
    conversationId: routine.conversationId,
    role: 'assistant',
    content: {
      text: assistantText,
      tool_uses: collectedToolUses.map((t) => ({ id: t.id, name: t.name, input: t.input, result: t.result })),
    },
  });
  await bumpLastMessageAt(routine.conversationId);

  return assistantText;
}
