import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/rpc.js';

export type Conv = { id: string; title: string; lastMessageAt: string };

export function useConversations() {
  const [conversations, setConversations] = useState<Conv[]>([]);
  const refresh = useCallback(async () => {
    const r = await api.listConversations();
    setConversations(r.conversations);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { conversations, refresh };
}
