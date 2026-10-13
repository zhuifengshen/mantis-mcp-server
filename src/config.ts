import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeBaseUrl } from './client.js';

// ---------------------------------------------------------------------------
// Config shape
// ---------------------------------------------------------------------------

/** 首次调用需要凭据的工具时解析连接配置。 */
export interface ConnectionConfig {
  baseUrl: string;
  apiKey: string;
}

/**
 * Values readable at server startup without any credentials, so the MCP
 * transport can connect and answer tools/list on an unconfigured install.
 */
export interface StartupConfig {
  cacheDir: string;
  cacheTtl: number;
  uploadDir?: string;
  enableDestructiveTools: boolean;
  workflowConfigPath?: string;
}

export type MantisConfig = ConnectionConfig & StartupConfig;

// ---------------------------------------------------------------------------
// .env.local loader
// ---------------------------------------------------------------------------

let cachedDotEnvLocal: Promise<void> | null = null;

/**
 * Loads .env.local at most once per process. Both getStartupConfig() and
 * getConfig() need it, and they may be called independently —
 * without memoising, the file is read twice on every startup. Caching the
 * promise (not a boolean) also makes concurrent callers share one read.
 */
function loadDotEnvLocal(): Promise<void> {
  if (!cachedDotEnvLocal) cachedDotEnvLocal = readDotEnvLocal();
  return cachedDotEnvLocal;
}

async function readDotEnvLocal(): Promise<void> {
  try {
    const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
    const content = await readFile(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const match = line.match(/^([^#=\s][^=]*)=(.*)/);
      if (match) {
        const key = match[1]!.trim();
        const value = match[2]!.trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) process.env[key] = value;
      }
    }
  } catch {
    // .env.local not present — use environment variables directly
  }
}

// ---------------------------------------------------------------------------
// Non-credential config (safe to read at startup without credentials)
// ---------------------------------------------------------------------------

function readNonCredentialConfig(): StartupConfig {
  const defaultCacheDir = join(homedir(), '.cache', 'mantisbt-mcp');
  const cacheDir = process.env.MANTIS_CACHE_DIR ?? defaultCacheDir;
  const cacheTtl = process.env.MANTIS_CACHE_TTL
    ? parseInt(process.env.MANTIS_CACHE_TTL, 10)
    : 3600;

  const flag = process.env.MANTIS_MCP_ENABLE_DESTRUCTIVE_TOOLS;
  if (flag && flag !== 'true' && flag !== 'false') {
    throw new Error('MANTIS_MCP_ENABLE_DESTRUCTIVE_TOOLS 只接受 true 或 false');
  }
  return {
    cacheDir,
    cacheTtl,
    uploadDir: process.env.MANTIS_UPLOAD_DIR,
    enableDestructiveTools: flag === 'true',
    workflowConfigPath: process.env.MANTIS_WORKFLOW_CONFIG || undefined,
  };
}

/**
 * Returns all non-credential config values. Does not require credentials, even when
 * MANTIS_BASE_URL / MANTIS_API_KEY are absent. Use this at server startup
 * so the MCP transport can connect and respond to tools/list without
 * requiring credentials to be configured.
 */
export async function getStartupConfig(): Promise<StartupConfig> {
  await loadDotEnvLocal();
  return readNonCredentialConfig();
}

// ---------------------------------------------------------------------------
// Full config (credentials required)
// ---------------------------------------------------------------------------

let cachedConfig: MantisConfig | null = null;

export async function getConfig(): Promise<MantisConfig> {
  if (cachedConfig) return cachedConfig;

  await loadDotEnvLocal();

  const baseUrl = process.env.MANTIS_BASE_URL ?? '';
  const apiKey = process.env.MANTIS_API_KEY ?? '';

  const missing: string[] = [];
  if (!baseUrl) missing.push('MANTIS_BASE_URL');
  if (!apiKey) missing.push('MANTIS_API_KEY');

  if (missing.length > 0) {
    throw new Error(
      `Missing required MantisBT configuration: ${missing.join(', ')}.\n` +
      `Set the environment variables MANTIS_BASE_URL and MANTIS_API_KEY.`
    );
  }

  cachedConfig = {
    baseUrl: normalizeBaseUrl(baseUrl),
    apiKey,
    ...readNonCredentialConfig(),
  };

  return cachedConfig;
}
