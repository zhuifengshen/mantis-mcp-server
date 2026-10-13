import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock 放在模块顶层，由 Vitest 自动提升。
vi.mock('node:fs/promises');

import { readFile, writeFile } from 'node:fs/promises';
import { MantisClient } from '../../src/client.js';
import { MetadataCache, type CachedMetadata } from '../../src/cache.js';
import type { MantisVersion } from '../../src/types.js';
import { registerProjectVersionTools } from '../../src/tools/project-versions.js';
import { MockMcpServer, makeResponse } from '../helpers/mock-server.js';

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

let mockServer: MockMcpServer;
let client: MantisClient;
let cache: MetadataCache;

beforeEach(() => {
  vi.resetAllMocks();
  mockServer = new MockMcpServer();
  client = new MantisClient('https://mantis.example.com', 'test-token');
  cache = new MetadataCache('/tmp/test-cache-project-versions', 3600);
  registerProjectVersionTools(mockServer as never, client, cache);
  vi.stubGlobal('fetch', vi.fn());
  // 默认没有缓存文件，版本更新不创建不完整的元数据缓存。
  vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
  vi.mocked(writeFile).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 辅助方法
// ---------------------------------------------------------------------------

const version = (overrides: Partial<MantisVersion> = {}): MantisVersion => ({
  id: 42,
  name: '1.2.0',
  released: false,
  obsolete: false,
  timestamp: '2026-09-01T10:00:00+02:00',
  ...overrides,
});

function versionResponse(v: MantisVersion, status = 200): Response {
  return makeResponse(status, JSON.stringify({ version: v }));
}

function fetchCall(index: number): { url: string; method: string; body: unknown } {
  const [url, init] = vi.mocked(fetch).mock.calls[index]! as [string, RequestInit];
  return {
    url,
    method: init.method ?? 'GET',
    body: init.body !== undefined ? JSON.parse(init.body as string) : undefined,
  };
}

/** 准备父项目 7 和继承版本 42 的子项目 8 的缓存。 */
function seedCache(): void {
  const data: CachedMetadata = {
    timestamp: 1_700_000_000_000,
    projects: [{ id: 7, name: 'Parent' }, { id: 8, name: 'Child' }],
    byProject: {
      7: { users: [], versions: [version()], categories: [] },
      8: { users: [], versions: [version(), version({ id: 43, name: 'child-only' })], categories: [] },
    },
    tags: [],
  };
  vi.mocked(readFile).mockResolvedValue(JSON.stringify({ timestamp: data.timestamp, data }) as any);
}

function writtenCache(): CachedMetadata {
  const content = vi.mocked(writeFile).mock.calls[0]![1] as string;
  return (JSON.parse(content) as { data: CachedMetadata }).data;
}

// ---------------------------------------------------------------------------
// create_version
// ---------------------------------------------------------------------------

describe('create_version', () => {
  it('工具已注册', () => {
    expect(mockServer.hasToolRegistered('create_version')).toBe(true);
  });

  it('向版本接口发送 POST 并返回创建结果', async () => {
    vi.mocked(fetch).mockResolvedValue(versionResponse(version(), 201));

    const result = await mockServer.callTool('create_version', { project_id: 7, name: '1.2.0' }, { validate: true });

    expect(result.isError).toBeUndefined();
    const call = fetchCall(0);
    expect(call.method).toBe('POST');
    expect(call.url).toContain('projects/7/versions');
    expect(JSON.parse(result.content[0]!.text)).toEqual(version());
  });

  it('仅发送调用方提供的字段', async () => {
    vi.mocked(fetch).mockResolvedValue(versionResponse(version(), 201));

    await mockServer.callTool('create_version', { project_id: 7, name: '1.2.0' }, { validate: true });

    expect(fetchCall(0).body).toEqual({ name: '1.2.0' });
  });

  it('传递所有可选字段', async () => {
    vi.mocked(fetch).mockResolvedValue(versionResponse(version(), 201));

    await mockServer.callTool('create_version', {
      project_id: 7,
      name: '1.2.0',
      description: 'Bugfix release',
      released: true,
      obsolete: false,
      timestamp: '2026-09-27T10:00:00+02:00',
    }, { validate: true });

    expect(fetchCall(0).body).toEqual({
      name: '1.2.0',
      description: 'Bugfix release',
      released: true,
      obsolete: false,
      timestamp: '2026-09-27T10:00:00+02:00',
    });
  });

  it('接受字符串形式的布尔值', async () => {
    vi.mocked(fetch).mockResolvedValue(versionResponse(version(), 201));

    await mockServer.callTool('create_version', { project_id: 7, name: '1.2.0', released: 'true' }, { validate: true });

    expect(fetchCall(0).body).toEqual({ name: '1.2.0', released: true });
  });

  it('空名称在请求前被拒绝', async () => {
    const result = await mockServer.callTool('create_version', { project_id: 7, name: '' }, { validate: true });

    expect(result.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('接口失败时返回 isError', async () => {
    vi.mocked(fetch).mockResolvedValue(makeResponse(403, JSON.stringify({ message: 'Access denied to add versions' })));

    const result = await mockServer.callTool('create_version', { project_id: 7, name: '1.2.0' }, { validate: true });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Access denied to add versions');
  });

  it('新版本仅加入所属项目缓存', async () => {
    seedCache();
    const created = version({ id: 50, name: '1.3.0' });
    vi.mocked(fetch).mockResolvedValue(versionResponse(created, 201));

    await mockServer.callTool('create_version', { project_id: 7, name: '1.3.0' }, { validate: true });

    const data = writtenCache();
    expect(data.byProject[7]!.versions.map((v) => v.id)).toEqual([42, 50]);
    expect(data.byProject[8]!.versions.map((v) => v.id)).toEqual([42, 43]);
  });
});

// ---------------------------------------------------------------------------
// update_version
// ---------------------------------------------------------------------------

describe('update_version', () => {
  it('工具已注册', () => {
    expect(mockServer.hasToolRegistered('update_version')).toBe(true);
  });

  it('PATCH 仅发送指定的版本字段', async () => {
    vi.mocked(fetch).mockResolvedValue(versionResponse(version({ obsolete: true })));

    const result = await mockServer.callTool('update_version', { project_id: 7, version_id: 42, obsolete: true }, { validate: true });

    expect(result.isError).toBeUndefined();
    const call = fetchCall(0);
    expect(call.method).toBe('PATCH');
    expect(call.url).toContain('projects/7/versions/42');
    expect(call.body).toEqual({ obsolete: true });
    expect(JSON.parse(result.content[0]!.text)).toEqual(version({ obsolete: true }));
  });

  it('保留显式传入的 false', async () => {
    vi.mocked(fetch).mockResolvedValue(versionResponse(version()));

    await mockServer.callTool('update_version', { project_id: 7, version_id: 42, released: false }, { validate: true });

    expect(fetchCall(0).body).toEqual({ released: false });
  });

  it('拒绝没有修改字段的请求', async () => {
    const result = await mockServer.callTool('update_version', { project_id: 7, version_id: 42 }, { validate: true });

    expect(result.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('更新所有项目缓存中的同编号版本，包括继承版本', async () => {
    seedCache();
    vi.mocked(fetch).mockResolvedValue(versionResponse(version({ name: '1.2.1' })));

    await mockServer.callTool('update_version', { project_id: 7, version_id: 42, name: '1.2.1' }, { validate: true });

    const data = writtenCache();
    expect(data.byProject[7]!.versions[0]!.name).toBe('1.2.1');
    expect(data.byProject[8]!.versions[0]!.name).toBe('1.2.1');
    expect(data.byProject[8]!.versions[1]!.name).toBe('child-only');
  });

  it('缓存写入失败时仍返回成功的 REST 更新结果', async () => {
    seedCache();
    vi.mocked(writeFile).mockRejectedValue(new Error('磁盘不可写'));
    vi.mocked(fetch).mockResolvedValue(versionResponse(version({ name: '1.2.1' })));
    const result = await mockServer.callTool('update_version', {
      project_id: '7', version_id: '42', name: '1.2.1', released: 'false',
    }, { validate: true });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0]!.text).name).toBe('1.2.1');
    expect(fetchCall(0).body).toEqual({ name: '1.2.1', released: false });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// release_version
// ---------------------------------------------------------------------------

describe('release_version', () => {
  it('工具已注册', () => {
    expect(mockServer.hasToolRegistered('release_version')).toBe(true);
  });

  it('发布时默认设置当前时间', async () => {
    vi.mocked(fetch).mockResolvedValue(versionResponse(version({ released: true })));
    const before = Date.now();

    const result = await mockServer.callTool('release_version', { project_id: 7, version_id: 42 }, { validate: true });

    expect(result.isError).toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
    const call = fetchCall(0);
    expect(call.method).toBe('PATCH');
    expect(call.url).toContain('projects/7/versions/42');
    const body = call.body as { released: boolean; timestamp: string };
    expect(body.released).toBe(true);
    const sent = Date.parse(body.timestamp);
    expect(sent).toBeGreaterThanOrEqual(before - 1000);
    expect(sent).toBeLessThanOrEqual(Date.now() + 1000);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ released: version({ released: true }) });
  });

  it('使用指定的发布日期', async () => {
    vi.mocked(fetch).mockResolvedValue(versionResponse(version({ released: true })));

    await mockServer.callTool('release_version', { project_id: 7, version_id: 42, timestamp: '2026-09-20' }, { validate: true });

    expect(fetchCall(0).body).toEqual({ released: true, timestamp: '2026-09-20' });
  });

  it('指定 next_version 时创建后续版本', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(versionResponse(version({ released: true })))
      .mockResolvedValueOnce(versionResponse(version({ id: 43, name: '1.2.1' }), 201));

    const result = await mockServer.callTool('release_version', { project_id: 7, version_id: 42, next_version: '1.2.1' }, { validate: true });

    expect(result.isError).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
    const second = fetchCall(1);
    expect(second.method).toBe('POST');
    expect(second.url).toContain('projects/7/versions');
    expect(second.body).toEqual({ name: '1.2.1' });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      released: version({ released: true }),
      next_version: version({ id: 43, name: '1.2.1' }),
    });
  });

  it('发布失败后不创建后续版本', async () => {
    vi.mocked(fetch).mockResolvedValue(makeResponse(404, JSON.stringify({ message: "Version with id '42' not found" })));

    const result = await mockServer.callTool('release_version', { project_id: 7, version_id: 42, next_version: '1.2.1' }, { validate: true });

    expect(result.isError).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    expect(result.content[0]!.text).toContain('not found');
  });

  it('后续版本创建失败时仍返回成功的发布结果', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(versionResponse(version({ released: true })))
      .mockResolvedValueOnce(makeResponse(400, JSON.stringify({ message: "Version '1.2.1' already exists" })));

    const result = await mockServer.callTool('release_version', { project_id: 7, version_id: 42, next_version: '1.2.1' }, { validate: true });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text) as { released: MantisVersion; next_version_error: string };
    expect(parsed.released).toEqual(version({ released: true }));
    expect(parsed.next_version_error).toContain('already exists');
  });
});

// ---------------------------------------------------------------------------
// delete_version
// ---------------------------------------------------------------------------

describe('delete_version', () => {
  it('工具已注册', () => {
    expect(mockServer.hasToolRegistered('delete_version')).toBe(true);
  });

  it('DELETE 正确处理无响应正文的 204', async () => {
    vi.mocked(fetch).mockResolvedValue(makeResponse(204, ''));

    const result = await mockServer.callTool('delete_version', { project_id: 7, version_id: 42 }, { validate: true });

    expect(result.isError).toBeUndefined();
    const call = fetchCall(0);
    expect(call.method).toBe('DELETE');
    expect(call.url).toContain('projects/7/versions/42');
    expect(result.content[0]!.text).toContain('42');
  });

  it('接口失败时返回 isError', async () => {
    vi.mocked(fetch).mockResolvedValue(makeResponse(403, JSON.stringify({ message: 'Access denied to delete version' })));

    const result = await mockServer.callTool('delete_version', { project_id: 7, version_id: 42 }, { validate: true });

    expect(result.isError).toBe(true);
  });

  it('从所有项目缓存中删除版本', async () => {
    seedCache();
    vi.mocked(fetch).mockResolvedValue(makeResponse(204, ''));

    await mockServer.callTool('delete_version', { project_id: 7, version_id: 42 }, { validate: true });

    const data = writtenCache();
    expect(data.byProject[7]!.versions).toEqual([]);
    expect(data.byProject[8]!.versions.map((v) => v.id)).toEqual([43]);
  });
});
