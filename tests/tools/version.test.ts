import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MantisClient } from '../../src/client.js';
import { registerVersionTools } from '../../src/tools/version.js';
import { MockMcpServer } from '../helpers/mock-server.js';

describe('内部版本读取', () => {
  let server: MockMcpServer;

  beforeEach(() => {
    server = new MockMcpServer();
    registerVersionTools(server as never, new MantisClient('https://mantis.invalid', 'test-token'), '3.0.0');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => vi.unstubAllGlobals());

  it('MCP 版本直接返回传入版本，不访问网络', async () => {
    const result = await server.callTool('get_mcp_version');
    expect(JSON.parse(result.content[0]!.text)).toEqual({ version: '3.0.0' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('Mantis 版本只从内部响应头读取，不执行官方版本比较', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { headers: { 'X-Mantis-Version': '2.26.2' } }));
    const result = await server.callTool('get_mantis_version');
    expect(JSON.parse(result.content[0]!.text)).toEqual({ installed_version: '2.26.2' });
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://mantis.invalid/api/rest/users/me', expect.objectContaining({ method: 'GET' }));
  });

  it('响应头缺失时返回 unknown，不尝试其他来源', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}'));
    const result = await server.callTool('get_mantis_version');
    expect(JSON.parse(result.content[0]!.text)).toEqual({ installed_version: 'unknown' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('认证失败时返回接口错误，不追加升级建议或额外请求', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 401, statusText: 'Unauthorized' }));
    const result = await server.callTool('get_mantis_version');
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('Error: MantisBT API error 401: Unauthorized');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('网络失败时保留原始错误，不重试官方接口', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('连接失败'));
    const result = await server.callTool('get_mantis_version');
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('Error: 连接失败');
    expect(fetch).toHaveBeenCalledOnce();
  });
});
