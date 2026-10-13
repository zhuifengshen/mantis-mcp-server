import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted — must be at module top level
vi.mock('node:fs/promises');

import { readFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reset the module registry so that the `cachedConfig` singleton in config.ts
 * is re-initialized for each test. Then import getConfig fresh.
 */
async function freshGetConfig(): Promise<(typeof import('../src/config.js'))['getConfig']> {
  vi.resetModules();
  const mod = await import('../src/config.js');
  return mod.getConfig;
}

async function freshGetStartupConfig(): Promise<(typeof import('../src/config.js'))['getStartupConfig']> {
  vi.resetModules();
  const mod = await import('../src/config.js');
  return mod.getStartupConfig;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('MANTIS_BASE_URL', undefined);
  vi.stubEnv('MANTIS_API_KEY', undefined);
  vi.stubEnv('MANTIS_MCP_ENABLE_DESTRUCTIVE_TOOLS', undefined);
  vi.stubEnv('MANTIS_WORKFLOW_CONFIG', undefined);
});

// ---------------------------------------------------------------------------
// ENV-based configuration
// ---------------------------------------------------------------------------

describe('getConfig() – ENV variables', () => {
  it('reads baseUrl and apiKey from environment variables', async () => {
    vi.stubEnv('MANTIS_BASE_URL', 'https://mantis.example.com');
    vi.stubEnv('MANTIS_API_KEY', 'env-api-key');

    const getConfig = await freshGetConfig();
    const config = await getConfig();

    expect(config.baseUrl).toBe('https://mantis.example.com');
    expect(config.apiKey).toBe('env-api-key');
  });

  it('strips trailing slash from baseUrl', async () => {
    vi.stubEnv('MANTIS_BASE_URL', 'https://mantis.example.com/');
    vi.stubEnv('MANTIS_API_KEY', 'key');

    const getConfig = await freshGetConfig();
    const config = await getConfig();

    expect(config.baseUrl).toBe('https://mantis.example.com');
  });

  it('strips /api/rest suffix from baseUrl when user includes it', async () => {
    vi.stubEnv('MANTIS_BASE_URL', 'https://mantis.example.com/api/rest');
    vi.stubEnv('MANTIS_API_KEY', 'key');

    const getConfig = await freshGetConfig();
    const config = await getConfig();

    expect(config.baseUrl).toBe('https://mantis.example.com');
  });

  it('strips /api/rest/ (with trailing slash) from baseUrl', async () => {
    vi.stubEnv('MANTIS_BASE_URL', 'https://mantis.example.com/api/rest/');
    vi.stubEnv('MANTIS_API_KEY', 'key');

    const getConfig = await freshGetConfig();
    const config = await getConfig();

    expect(config.baseUrl).toBe('https://mantis.example.com');
  });

  it('parses MANTIS_CACHE_TTL as a number', async () => {
    vi.stubEnv('MANTIS_BASE_URL', 'https://mantis.example.com');
    vi.stubEnv('MANTIS_API_KEY', 'key');
    vi.stubEnv('MANTIS_CACHE_TTL', '7200');

    const getConfig = await freshGetConfig();
    const config = await getConfig();

    expect(config.cacheTtl).toBe(7200);
  });

  it('uses 3600 as default cacheTtl when MANTIS_CACHE_TTL is not set', async () => {
    vi.stubEnv('MANTIS_BASE_URL', 'https://mantis.example.com');
    vi.stubEnv('MANTIS_API_KEY', 'key');

    const getConfig = await freshGetConfig();
    const config = await getConfig();

    expect(config.cacheTtl).toBe(3600);
  });

  it('uses MANTIS_CACHE_DIR when provided', async () => {
    vi.stubEnv('MANTIS_BASE_URL', 'https://mantis.example.com');
    vi.stubEnv('MANTIS_API_KEY', 'key');
    vi.stubEnv('MANTIS_CACHE_DIR', '/custom/cache/dir');

    const getConfig = await freshGetConfig();
    const config = await getConfig();

    expect(config.cacheDir).toBe('/custom/cache/dir');
  });


});

// ---------------------------------------------------------------------------
// .env.local loading
// ---------------------------------------------------------------------------

describe('.env.local loading', () => {
  it('reads .env.local only once across getStartupConfig and getConfig', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
    vi.stubEnv('MANTIS_BASE_URL', 'https://mantis.example.com');
    vi.stubEnv('MANTIS_API_KEY', 'key');

    vi.resetModules();
    const mod = await import('../src/config.js');
    await mod.getStartupConfig();
    await mod.getConfig();

    expect(vi.mocked(readFile)).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('getConfig() – errors', () => {
  it('throws when MANTIS_BASE_URL is not set', async () => {
    vi.stubEnv('MANTIS_API_KEY', 'some-key');

    const getConfig = await freshGetConfig();
    await expect(getConfig()).rejects.toThrow('MANTIS_BASE_URL');
  });

  it('throws when MANTIS_API_KEY is not set', async () => {
    vi.stubEnv('MANTIS_BASE_URL', 'https://mantis.example.com');

    const getConfig = await freshGetConfig();
    await expect(getConfig()).rejects.toThrow('MANTIS_API_KEY');
  });

  it('throws when no configuration is provided at all', async () => {
    const getConfig = await freshGetConfig();
    await expect(getConfig()).rejects.toThrow('Missing required MantisBT configuration');
  });
});

// ---------------------------------------------------------------------------
// getStartupConfig — never throws without credentials
// ---------------------------------------------------------------------------

describe('getStartupConfig()', () => {
  it.each([undefined, '', 'false'])('keeps administrative tools disabled for %s', async value => {
    vi.stubEnv('MANTIS_MCP_ENABLE_DESTRUCTIVE_TOOLS', value);
    const getStartupConfig = await freshGetStartupConfig();
    expect((await getStartupConfig()).enableDestructiveTools).toBe(false);
  });

  it('enables all administrative tools only for the literal true flag', async () => {
    vi.stubEnv('MANTIS_MCP_ENABLE_DESTRUCTIVE_TOOLS', 'true');
    vi.stubEnv('MANTIS_WORKFLOW_CONFIG', '/tmp/deployment/workflow.json');
    const getStartupConfig = await freshGetStartupConfig();
    expect(await getStartupConfig()).toMatchObject({
      enableDestructiveTools: true,
      workflowConfigPath: '/tmp/deployment/workflow.json',
    });
  });

  it.each(['1', 'TRUE', 'yes', ' false '])('rejects ambiguous administrative flag %s', async value => {
    vi.stubEnv('MANTIS_MCP_ENABLE_DESTRUCTIVE_TOOLS', value);
    const getStartupConfig = await freshGetStartupConfig();
    await expect(getStartupConfig()).rejects.toThrow('MANTIS_MCP_ENABLE_DESTRUCTIVE_TOOLS');
  });

  it('succeeds without MANTIS_BASE_URL and MANTIS_API_KEY', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));

    const getStartupConfig = await freshGetStartupConfig();
    const config = await getStartupConfig();

    expect(config).toBeDefined();
    expect(config.cacheTtl).toBe(3600);
  });

  it('does not include baseUrl or apiKey', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));

    const getStartupConfig = await freshGetStartupConfig();
    const config = await getStartupConfig();

    expect(config).not.toHaveProperty('baseUrl');
    expect(config).not.toHaveProperty('apiKey');
  });

  it('reads MANTIS_CACHE_DIR from environment', async () => {
    vi.stubEnv('MANTIS_CACHE_DIR', '/tmp/test-cache');
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));

    const getStartupConfig = await freshGetStartupConfig();
    const config = await getStartupConfig();

    expect(config.cacheDir).toBe('/tmp/test-cache');
  });
});

// ---------------------------------------------------------------------------
// Singleton caching
// ---------------------------------------------------------------------------

describe('getConfig() – singleton', () => {
  it('returns the same object on repeated calls within the same module instance', async () => {
    vi.stubEnv('MANTIS_BASE_URL', 'https://mantis.example.com');
    vi.stubEnv('MANTIS_API_KEY', 'key');

    const getConfig = await freshGetConfig();
    const first = await getConfig();
    const second = await getConfig();

    expect(first).toBe(second);
  });
});
