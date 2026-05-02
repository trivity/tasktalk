import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getValidAccessToken } from './token-refresh.js';

const CLICKUP_MCP_URL = 'https://mcp.clickup.com/mcp';

export type McpSession = {
  client: Client;
  workspaceId: string;
  close: () => Promise<void>;
};

export async function openMcpSession(userId: string): Promise<McpSession> {
  const { accessToken, workspaceId } = await getValidAccessToken(userId);
  const transport = new StreamableHTTPClientTransport(new URL(CLICKUP_MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: 'tasktalk', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    workspaceId,
    close: async () => {
      try { await client.close(); } catch { /* ignore */ }
    },
  };
}

/**
 * Per-turn pool primitive. The caller (Claude turn loop) creates one of these
 * at the start of a turn, calls .get() on the first MCP-needing tool call, and
 * .closeAll() at the end of the turn. Lazy: if no MCP call happens, no session opens.
 */
export class TurnMcpPool {
  private session: McpSession | null = null;
  constructor(private readonly userId: string) {}

  async get(): Promise<McpSession> {
    if (this.session) return this.session;
    this.session = await openMcpSession(this.userId);
    return this.session;
  }

  async closeAll(): Promise<void> {
    if (this.session) {
      await this.session.close();
      this.session = null;
    }
  }
}

export async function callMcpTool<T = unknown>(session: McpSession, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await session.client.callTool({ name, arguments: args });
  return result as unknown as T;
}

/**
 * Open an MCP session using a raw access token (no DB lookup). Used during
 * the OAuth callback before the clickup_connections row exists, to discover
 * the user's workspace_id directly from the MCP server.
 */
export async function openMcpSessionWithToken(accessToken: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StreamableHTTPClientTransport(new URL(CLICKUP_MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: 'tasktalk', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      try { await client.close(); } catch { /* ignore */ }
    },
  };
}
