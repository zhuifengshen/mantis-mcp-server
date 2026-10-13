#!/usr/bin/env node
// 验证真正交付的 tarball：独立目录、仅生产依赖、实际命令入口和 stdio 握手。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'artifacts');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const consumer = await realpath(await mkdtemp(join(tmpdir(), 'mantis-package-consumer-')));
const npm = process.platform === 'win32' ? 'cmd.exe' : 'npm';
const npmArgs = process.platform === 'win32' ? ['/c', 'npm'] : [];
function run(args, cwd) {
  const result = spawnSync(npm, [...npmArgs, ...args], { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024,
    windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`${args[0]} 失败：${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

try {
  await mkdir(output, { recursive: true });
  const [packed] = JSON.parse(run(['pack', '--json', '--foreground-scripts=false', '--pack-destination', output], root));
  const files = packed.files.map(f => f.path);
  const docs = ['docs/cookbook.md', 'docs/examples.md', 'docs/migration-v6.md', 'docs/workflow-config.example.json'];
  const allowed = new Set(['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', ...docs]);
  assert(files.every(f => /^dist\/[\w/-]+\.js$/.test(f) || allowed.has(f)), '安装包带入了非发布文件');
  for (const required of ['dist/index.js', ...allowed]) assert(files.includes(required), `安装包缺少 ${required}`);
  const tarball = join(output, packed.filename);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'mantis-package-consumer', version: '1.0.0', private: true }));
  run(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0', '--fetch-timeout=30000', tarball], consumer);
  const require = createRequire(join(consumer, 'package.json'));
  const entry = require.resolve(pkg.name);
  const installed = join(consumer, 'node_modules', ...pkg.name.split('/'));
  assert.equal(entry, join(installed, 'dist', 'index.js'), '解析到了源码工作区而非安装包');
  const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(metadata.version, pkg.version);
  assert.equal(metadata.bin['mantis-mcp-server'], 'dist/index.js');
  assert((await readFile(entry, 'utf8')).startsWith('#!/usr/bin/env node'));
  const rootFiles = await readdir(installed);
  for (const name of ['src', 'tests', 'scripts', '.env', '.env.local']) assert(!rootFiles.includes(name), `不应安装 ${name}`);
  for (const dev of ['tsx', 'typescript', 'vitest']) {
    await assert.rejects(access(join(consumer, 'node_modules', dev)), { code: 'ENOENT' });
  }
  const cli = join(consumer, 'node_modules', '.bin', `mantis-mcp-server${process.platform === 'win32' ? '.cmd' : ''}`);
  await access(cli);
  for (const admin of [false, true]) {
    const client = new Client({ name: 'package-install-check', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: cli, cwd: consumer,
      env: { MANTIS_BASE_URL: '', MANTIS_API_KEY: '', MANTIS_CACHE_DIR: join(consumer, 'state'),
        MANTIS_WORKFLOW_CONFIG: join(installed, 'docs/workflow-config.example.json'),
        MANTIS_MCP_ENABLE_DESTRUCTIVE_TOOLS: String(admin) }, stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', chunk => { stderr += String(chunk); });
    try {
      await client.connect(transport, { timeout: 15000 });
      assert.equal(client.getServerVersion()?.version, pkg.version);
      const { tools } = await client.listTools();
      assert.equal(tools.length, admin ? 23 : 13);
      for (const legacy of ['create_issue', 'update_issue', 'get_issue']) assert(!tools.some(t => t.name === legacy));
      assert.equal(tools.some(t => t.name === 'close_issue'), admin);
      assert.equal((await client.listPrompts()).prompts.length, 5);
      console.log(`安装包 MCP 握手通过：扩展=${admin}，工具=${tools.length}`);
    } catch (error) {
      throw new Error(`安装包 stdio 验证失败：${error.message}\n${stderr}`);
    } finally {
      await client.close();
    }
  }
  const sha256 = createHash('sha256').update(await readFile(tarball)).digest('hex');
  await writeFile(`${tarball}.sha256`, `${sha256}  ${packed.filename}\n`);
  await writeFile(join(output, 'package-verification.json'), JSON.stringify({ name: pkg.name, version: pkg.version,
    filename: packed.filename, sha256, size: packed.size, files, node: process.version,
    verified_at: new Date().toISOString(), production_install: true, default_tools: 13, extended_tools: 23 }, null, 2) + '\n');
  console.log(`发布包验证通过：${tarball}\nSHA-256：${sha256}`);
} finally {
  await rm(consumer, { recursive: true, force: true });
}
