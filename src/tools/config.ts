import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MantisClient } from '../client.js';
import { MetadataCache } from '../cache.js';
import { ISSUE_ENUM_OPTIONS, MANTIS_CANONICAL_ENUM_NAMES } from '../constants.js';
import type { MantisEnumEntry } from '../types.js';

// MantisBT config API: enum values may be a pre-parsed array (2.x) or legacy "id:name,..." string
type EnumEntry = { id: number; name: string; label?: string };

function errorText(msg: string): string {
  return `Error: ${msg}`;
}

// Parse a MantisBT enum string ("10:feature,20:trivial,...") into {id, name}[]
function parseEnumString(raw: string): Array<{ id: number; name: string }> {
  return raw
    .split(',')
    .map((entry) => {
      const colonIdx = entry.indexOf(':');
      if (colonIdx === -1) return null;
      const id = parseInt(entry.slice(0, colonIdx), 10);
      const name = entry.slice(colonIdx + 1).trim();
      return isNaN(id) ? null : { id, name };
    })
    .filter((e): e is { id: number; name: string } => e !== null);
}

function resolveCanonicalName(id: number, name: string, canonicalMap: Record<number, string>): string | undefined {
  const canonical = canonicalMap[id];
  return canonical !== undefined && canonical !== name ? canonical : undefined;
}

export async function fetchIssueEnums(
  client: MantisClient,
): Promise<Record<string, MantisEnumEntry[]>> {
  const params: Record<string, string | number | boolean | undefined> = {};
  ISSUE_ENUM_OPTIONS.forEach((opt, i) => {
    params[`option[${i}]`] = opt;
  });

  const result = await client.get<{ configs: Array<{ option: string; value: string | EnumEntry[] }> }>('config', params);
  const configs = result.configs ?? [];

  const keyMap: Record<string, string> = {
    severity_enum_string: 'severity',
    status_enum_string: 'status',
    priority_enum_string: 'priority',
    resolution_enum_string: 'resolution',
    reproducibility_enum_string: 'reproducibility',
  };

  const enums: Record<string, MantisEnumEntry[]> = {};
  for (const { option, value } of configs) {
    const key = keyMap[option];
    if (!key) continue;
    const canonicalMap = MANTIS_CANONICAL_ENUM_NAMES[key] ?? {};
    if (typeof value === 'string') {
      enums[key] = parseEnumString(value).map(({ id, name }) => {
        const entry: MantisEnumEntry = { id, name };
        const canonical_name = resolveCanonicalName(id, name, canonicalMap);
        if (canonical_name !== undefined) entry.canonical_name = canonical_name;
        return entry;
      });
    } else if (Array.isArray(value)) {
      enums[key] = value.map(({ id, name, label }) => {
        const entry: MantisEnumEntry = { id, name };
        if (label && label !== name) entry.label = label;
        const canonical_name = resolveCanonicalName(id, name, canonicalMap);
        if (canonical_name !== undefined) entry.canonical_name = canonical_name;
        return entry;
      });
    }
  }

  return enums;
}

let _enumDataCache: { data: Record<string, MantisEnumEntry[]>; fetchedAt: number } | null = null;
const ENUM_DATA_CACHE_TTL_MS = 5 * 60 * 1000;

export async function fetchIssueEnumsWithCache(
  client: MantisClient,
): Promise<Record<string, MantisEnumEntry[]>> {
  if (_enumDataCache && (Date.now() - _enumDataCache.fetchedAt) < ENUM_DATA_CACHE_TTL_MS) {
    return _enumDataCache.data;
  }
  const data = await fetchIssueEnums(client);
  _enumDataCache = { data, fetchedAt: Date.now() };
  return data;
}

/** Resets the in-memory enum cache. Intended for use in tests. */
export function clearIssueEnumCache(): void {
  _enumDataCache = null;
}

export function registerConfigTools(server: McpServer, client: MantisClient, cache: MetadataCache): void {

  // ---------------------------------------------------------------------------
  // get_config
  // ---------------------------------------------------------------------------

  server.registerTool(
    'get_config',
    {
      title: "读取 Mantis 配置",
      description: "读取一个或多个 Mantis 配置项。常用名称：status_enum_string（状态）、priority_enum_string（优先级）、severity_enum_string（严重程度）、resolution_enum_string（解决结果）、reproducibility_enum_string（复现频率）、view_state_enum_string（可见性）、access_levels_enum_string（访问级别）。",
      inputSchema: z.object({
        options: z.array(z.string()).min(1).describe("需要读取的配置项名称数组"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ options }) => {
      try {
        const params: Record<string, string | number | boolean | undefined> = {};
        options.forEach((opt, i) => {
          params[`option[${i}]`] = opt;
        });
        const result = await client.get<unknown>('config', params);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // get_issue_enums
  // ---------------------------------------------------------------------------

  server.registerTool(
    'get_issue_enums',
    {
      title: "读取缺陷枚举",
      description: "返回缺陷枚举字段的有效值，包括 severity、status、priority、resolution、reproducibility。创建或更新前先查询有效值。\n\nid 是 API 使用的编号，name 是标准名称或实例本地化名称，label 是界面标签（与 name 不同时提供），canonical_name 是标准英文名（本地化名称不同时提供）。例如状态可返回 {\"id\":80,\"name\":\"resolved\",\"label\":\"已解决\"}。\n\ncreate_issue 的 severity、priority、reproducibility 接受标准英文名、本地化 name 或 label；服务端会解析为编号。update_issue 的字段引用使用 {id} 或 {name}。自定义枚举以当前实例返回值为准。",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const enums = await fetchIssueEnums(client);
        return {
          content: [{ type: 'text', text: JSON.stringify(enums, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // list_languages
  // ---------------------------------------------------------------------------

  server.registerTool(
    'list_languages',
    {
      title: "列出支持的语言",
      description: "列出当前 Mantis 实例支持的语言。",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const result = await client.get<unknown>('lang');
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // list_tags
  // ---------------------------------------------------------------------------

  server.registerTool(
    'list_tags',
    {
      title: "列出标签",
      description: "列出 Mantis 标签。优先读取 GET /tags；接口不存在时使用 sync_metadata 填充的本地元数据缓存。",
      inputSchema: z.object({
        page: z.coerce.number().int().positive().default(1).describe("页码，默认 1"),
        page_size: z.coerce.number().int().min(1).max(200).default(50).describe("每页标签数，默认 50"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ page, page_size }) => {
      try {
        const result = await client.get<unknown>('tags', { page, page_size });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('404')) {
          // GET /tags endpoint not available — fall back to metadata cache
          const metadata = await cache.load();
          if (metadata && Array.isArray(metadata.tags) && metadata.tags.length > 0) {
            const start = (page - 1) * page_size;
            const paginated = metadata.tags.slice(start, start + page_size);
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({ tags: paginated, source: 'cache' }, null, 2),
              }],
            };
          }
          return {
            content: [{
              type: 'text',
              text: `Error: ${msg}\n\nThe GET /tags endpoint is not available in this MantisBT installation. No cached tags found either — run sync_metadata to populate the cache if your installation provides this endpoint.`,
            }],
            isError: true,
          };
        }
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );
}
