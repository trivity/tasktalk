import { useMemo } from 'react';

type Msg = { role: string; content: any };

export function useTaskContext(history: Msg[]) {
  return useMemo(() => {
    const tasks = new Map<string, { id: string; name: string }>();
    for (const m of history) {
      const tu = (m.content?.tool_uses as Array<{ name: string; input: Record<string, unknown> }> | undefined) ?? [];
      for (const t of tu) {
        const id = (t.input.task_id as string | undefined);
        if (id) tasks.set(id, { id, name: id });
      }
      const taskBlob = JSON.stringify(m.content ?? '');
      // best-effort scrape of "task_id":"..." from tool results
      const matches = taskBlob.matchAll(/"task_id":"([^"]+)"[^}]*"name":"([^"]+)"/g);
      for (const match of matches) tasks.set(match[1]!, { id: match[1]!, name: match[2]! });
    }
    return Array.from(tasks.values()).slice(-8);
  }, [history]);
}
