#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { getConfig, getStartupConfig } from './config.js';
import { MantisClient } from './client.js';
import { Bindings } from './workflow/bindings.js';
import { Context } from './workflow/context.js';
import { Executor } from './workflow/executor.js';
import { conservativeCapabilities } from './workflow/query.js';
import { Projects } from './services/projects.js';
import { Issues } from './services/issues.js';
import { registerWorkflowTools } from './tools/workflow.js';
import { registerAdminTools } from './tools/admin.js';
import { registerPrompts } from './prompts/index.js';
import { registerResources } from './resources/index.js';

// ---------------------------------------------------------------------------
// Read version from package.json
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')
) as { version: string };
const version = packageJson.version;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function createMcpServer(): Promise<McpServer> {
  // Use startup config (no credentials required) so the server can connect
  // and respond to tools/list even without MANTIS_BASE_URL / MANTIS_API_KEY.
  // Credentials are resolved lazily on the first actual tool invocation.
  const startupConfig = await getStartupConfig();

  const client = new MantisClient(
    async () => {
      const config = await getConfig();
      return {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
      };
    },
  );
  const bindings = await Bindings.load(startupConfig.workflowConfigPath);
  const context = new Context(new Projects(client, startupConfig.cacheDir, startupConfig.cacheTtl), new Issues(client), bindings,
    startupConfig.enableDestructiveTools, version);
  const capabilities = { ...conservativeCapabilities };
  const executor = new Executor(context, capabilities, startupConfig.uploadDir);
  const server = new McpServer({ name: 'mantis-mcp-server', version });
  registerWorkflowTools(server, context, executor, capabilities);
  registerAdminTools(server, context, executor, capabilities);
  registerPrompts(server, context.admin);
  registerResources(server, context);

  return server;
}

// ---------------------------------------------------------------------------
// 传输：仅支持 stdio
// ---------------------------------------------------------------------------

async function runStdio(): Promise<void> {
  const server = await createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`MantisBT MCP Server v${version} running (stdio)`);

  // 客户端关闭标准输入时退出，避免会话结束后残留服务进程。
  process.stdin.once('close', () => process.exit(0));
}

runStdio().catch((err: unknown) => {
  console.error('Mantis MCP 服务启动失败：', err instanceof Error ? err.message : err);
  process.exit(1);
});
