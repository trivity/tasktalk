import { describe, it, expect } from 'vitest';
import { executeTool } from '../../../src/server/claude/execute-tool.js';
import { TurnMcpPool } from '../../../src/server/mcp/client.js';

describe('executeTool', () => {
  it('rejects unknown tool name', async () => {
    const pool = new TurnMcpPool('user-x');
    const r = await executeTool({ name: 'bogus', args: {}, workspaceIds: ['ws'], pool });
    expect(r.error).toMatch(/unknown tool/i);
  });
});
