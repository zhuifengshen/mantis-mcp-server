import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MantisClient, buildNoteViewUrl } from '../client.js';
import type { MantisNote } from '../types.js';

function errorText(msg: string): string {
  return `Error: ${msg}`;
}

// Shared with update_issue (note parameter) — posts a note and returns it enriched with view_url.
export async function postNote(
  client: MantisClient,
  issueId: number,
  text: string,
  viewState: 'public' | 'private',
): Promise<MantisNote> {
  const body = {
    text,
    view_state: { name: viewState },
  };
  const [result, baseUrl] = await Promise.all([
    client.post<{ note: MantisNote }>(`issues/${issueId}/notes`, body),
    client.getBaseUrl(),
  ]);
  const note = result.note ?? (result as unknown as MantisNote);
  return { ...note, view_url: buildNoteViewUrl(baseUrl, issueId, note.id) };
}

export function registerNoteTools(server: McpServer, client: MantisClient): void {

  // ---------------------------------------------------------------------------
  // list_notes
  // ---------------------------------------------------------------------------

  server.registerTool(
    'list_notes',
    {
      title: "列出缺陷备注",
      description: "列出缺陷的全部备注。get_issue 默认也包含 notes；只需备注时使用本工具。",
      inputSchema: z.object({
        issue_id: z.coerce.number().int().positive().describe("缺陷编号（数字）"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ issue_id }) => {
      try {
        const [result, baseUrl] = await Promise.all([
          client.get<{ issues: Array<{ notes?: MantisNote[] }> }>(`issues/${issue_id}`),
          client.getBaseUrl(),
        ]);
        const notes = (result.issues?.[0]?.notes ?? []).map(note => ({
          ...note,
          view_url: buildNoteViewUrl(baseUrl, issue_id, note.id),
        }));
        return {
          content: [{ type: 'text', text: JSON.stringify(notes, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // add_note
  // ---------------------------------------------------------------------------

  server.registerTool(
    'add_note',
    {
      title: "添加缺陷备注",
      description: "为已有缺陷添加备注，返回备注信息及定位备注的 view_url。支持 UTF-8，Markdown 按原文保存，显示效果取决于 Mantis 渲染配置。view_state=private 表示私有，所需访问级别以内部实例配置为准。issue_id 可通过 list_issues 或 get_issue 查询。",
      inputSchema: z.object({
        issue_id: z.coerce.number().int().positive().describe("缺陷编号，使用 list_issues 或 get_issue 查询"),
        text: z.string().min(1).describe("备注正文，至少 1 个字符，支持 UTF-8 和表情；Markdown 按原文保存"),
        view_state: z.enum(['public', 'private']).default('public').describe("备注可见性：public（公开，默认）或 private（私有，需具备对应访问权限）"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ issue_id, text, view_state }) => {
      try {
        const note = await postNote(client, issue_id, text, view_state);
        return {
          content: [{ type: 'text', text: JSON.stringify(note, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // delete_note
  // ---------------------------------------------------------------------------

  server.registerTool(
    'delete_note',
    {
      title: "删除备注",
      description: "永久删除缺陷备注，不可恢复。成功返回确认文本，备注不存在或权限不足时返回错误；删除权限由 Mantis 控制。issue_id 和 note_id 来自 get_issue 的 notes 数组或 list_notes。",
      inputSchema: z.object({
        issue_id: z.coerce.number().int().positive().describe("备注所属的缺陷编号，使用 get_issue 或 list_notes 确认"),
        note_id: z.coerce.number().int().positive().describe("待删除备注的编号，来自 get_issue 的 notes[].id 或 list_notes"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ issue_id, note_id }) => {
      try {
        await client.delete<unknown>(`issues/${issue_id}/notes/${note_id}`);
        return {
          content: [{ type: 'text', text: `Note #${note_id} deleted from issue #${issue_id}.` }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );
}
