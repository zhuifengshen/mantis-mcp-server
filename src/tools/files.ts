import { readFile } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MantisClient } from '../client.js';
import type { MantisFile } from '../types.js';

function errorText(msg: string): string {
  return `Error: ${msg}`;
}

export function registerFileTools(
  server: McpServer,
  client: MantisClient,
  uploadDir?: string,
): void {
  const normalizedUploadDir = uploadDir ? resolve(uploadDir) + sep : undefined;
  // ---------------------------------------------------------------------------
  // list_issue_files
  // ---------------------------------------------------------------------------

  server.registerTool(
    'list_issue_files',
    {
      title: "列出缺陷附件",
      description: "列出缺陷附件，返回 id、filename、size、content_type、download_url 等元数据；无附件时返回空数组。上传使用 upload_file，完整详情使用 get_issue。",
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
        const result = await client.get<{ issues: Array<{ attachments?: MantisFile[] }> }>(`issues/${issue_id}`);
        const attachments = result.issues?.[0]?.attachments ?? [];
        return {
          content: [{ type: 'text', text: JSON.stringify(attachments, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // upload_file
  // ---------------------------------------------------------------------------

  server.registerTool(
    'upload_file',
    {
      title: "上传附件",
      description: "为已有缺陷上传附件，不修改缺陷字段或状态，成功后返回附件元数据。\n\nfile_path 与 content 必须二选一：优先传本地文件绝对路径 file_path，服务端读取并编码，默认从路径提取文件名；无法通过路径访问时传 Base64 content，并填写 filename。配置 MANTIS_UPLOAD_DIR 后，本地路径必须位于该目录内。\n\ncontent_type 默认 application/octet-stream，可设为 image/png 等；description 为可选说明。查看已有附件使用 list_issue_files。",
      inputSchema: z.object({
        issue_id: z.coerce.number().int().positive().describe("缺陷编号（数字）"),
        file_path: z.string().min(1).optional().describe("优先使用：待上传本地文件的绝对路径，与 content 互斥"),
        content: z.string().min(1).optional().describe("备用方式：Base64 编码的文件内容，仅在无法使用 file_path 时使用，与 file_path 互斥"),
        filename: z.string().min(1).optional().describe("附件文件名：使用 content 时必填；使用 file_path 时可覆盖从路径提取的文件名"),
        content_type: z.string().optional().describe("文件 MIME 类型，例如 image/png；默认 application/octet-stream"),
        description: z.string().optional().describe("可选的附件说明"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ issue_id, file_path, content, filename, content_type, description }) => {
      try {
        if (!file_path && !content) {
          return { content: [{ type: 'text', text: 'Error: Either file_path or content must be provided' }], isError: true };
        }
        if (file_path && content) {
          return { content: [{ type: 'text', text: 'Error: Only one of file_path or content may be provided' }], isError: true };
        }

        let base64Content: string;
        let fileName: string;

        if (file_path) {
          if (normalizedUploadDir) {
            const normalizedPath = resolve(file_path);
            if (!normalizedPath.startsWith(normalizedUploadDir)) {
              return { content: [{ type: 'text', text: errorText('file_path is not allowed — access restricted to the designated upload directory') }], isError: true };
            }
          }
          const fileBuffer = await readFile(file_path);
          base64Content = fileBuffer.toString('base64');
          fileName = filename ?? basename(file_path);
        } else {
          if (!filename) {
            return { content: [{ type: 'text', text: 'Error: filename is required when using content' }], isError: true };
          }
          base64Content = content!;
          fileName = filename;
        }

        const body = {
          files: [{ name: fileName, type: content_type ?? 'application/octet-stream', content: base64Content }],
          ...(description && { description }),
        };
        const result = await client.post<unknown>(`issues/${issue_id}/files`, body);
        return {
          content: [{ type: 'text', text: JSON.stringify(result ?? { success: true }, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );
}
