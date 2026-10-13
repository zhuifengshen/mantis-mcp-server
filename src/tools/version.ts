import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MantisClient } from '../client.js';

export function registerVersionTools(server: McpServer, client: MantisClient, mcpVersion: string): void {

  // ---------------------------------------------------------------------------
  // get_mcp_version
  // ---------------------------------------------------------------------------

  server.registerTool(
    'get_mcp_version',
    {
      title: "读取 MCP 服务版本",
      description: "返回当前 mantis-mcp-server 实例的版本号。",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify({ version: mcpVersion }, null, 2) }],
    }),
  );

  // ---------------------------------------------------------------------------
  // get_mantis_version
  // ---------------------------------------------------------------------------

  server.registerTool(
    'get_mantis_version',
    {
      title: "读取 Mantis 版本",
      description: "读取内部 Mantis 的版本号，来源为 REST 响应头 X-Mantis-Version。不检查官方更新；响应头缺失时 installed_version 返回 unknown。",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const installedRaw = await client.getVersion();
        const result: Record<string, unknown> = { installed_version: installedRaw };


        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    }
  );
}
