import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { WorkflowError } from '../workflow/contracts.js';

export const uploadPolicy = {
  max_file_size_bytes: 41943040,
  allowed_extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'svg', 'bmp', 'tif', 'tiff',
    'mp4', 'mov', 'webm', 'm4v', 'avi', 'mkv', 'mpg', 'mpeg', '3gp', 'wmv', 'html', 'pdf', 'txt', 'doc', 'xml', 'xls', 'ppt', 'apk', 'ipa'],
  single_file_only: true, accepts_directories: false, input_mode: 'file_path', source: 'deployment_policy',
} as const;
const mime: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  heic: 'image/heic', heif: 'image/heif', svg: 'image/svg+xml', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
  mpg: 'video/mpeg', mpeg: 'video/mpeg', '3gp': 'video/3gpp', wmv: 'video/x-ms-wmv', html: 'text/html', pdf: 'application/pdf',
  txt: 'text/plain', doc: 'application/msword', xml: 'application/xml', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  apk: 'application/vnd.android.package-archive', ipa: 'application/octet-stream' };
export interface FileInfo { filename: string; size: number; content_type: string; file_sha256: string }
let uploadBusy = false;
export function reserveUpload(): () => void {
  if (uploadBusy) throw new WorkflowError('OPERATION_BUSY', '本进程正在处理另一个上传，请稍后重试原操作');
  uploadBusy = true;
  return () => { uploadBusy = false; };
}
function validName(name: string): string {
  if (!name || /[\/\\\x00-\x1f\x7f]/.test(name) || name === '.' || name === '..') throw new WorkflowError('INVALID_INPUT', '附件名称必须为纯文件名');
  const ext = extname(name).slice(1).toLowerCase();
  if (!(uploadPolicy.allowed_extensions as readonly string[]).includes(ext)) throw new WorkflowError('FILE_TYPE_NOT_ALLOWED', '附件扩展名不在部署白名单内');
  return ext;
}
function checkSize(size: number) {
  if (size === 0) throw new WorkflowError('FILE_EMPTY', '不允许上传空文件');
  if (size > uploadPolicy.max_file_size_bytes) throw new WorkflowError('FILE_TOO_LARGE', '附件不得超过 41943040 字节');
}
export async function readUpload(path: string, filename?: string, expectedHash?: string, root?: string): Promise<{ info: FileInfo; bytes: Buffer }> {
  if (!isAbsolute(path)) throw new WorkflowError('INVALID_INPUT', 'file_path 必须为本地绝对路径');
  const sourceExt = validName(basename(path));
  const name = filename ?? basename(path);
  if (validName(name) !== sourceExt) throw new WorkflowError('FILE_TYPE_NOT_ALLOWED', '覆盖文件名必须保留相同扩展名');
  let resolved: string;
  try { resolved = await realpath(path); } catch { throw new WorkflowError('FILE_NOT_REGULAR', '文件不存在或不可读取'); }
  const resolvedRoot = root ? await realpath(root) : undefined;
  if (resolvedRoot) {
    const local = relative(resolvedRoot, resolved);
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new WorkflowError('FILE_OUTSIDE_UPLOAD_DIR', '文件真实路径不在允许目录内');
  }
  const original = await stat(resolved);
  if (!original.isFile()) throw new WorkflowError('FILE_NOT_REGULAR', '仅允许单个普通文件，不能上传目录或特殊文件');
  checkSize(original.size);
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    const signature = (s: typeof before) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':');
    if (!before.isFile() || signature(before) !== signature(original)) throw new WorkflowError('FILE_CHANGED', '文件在校验期间发生变化');
    const chunks: Buffer[] = [];
    let size = 0;
    const hash = createHash('sha256');
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, uploadPolicy.max_file_size_bytes + 1 - size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      checkSize(size);
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk); chunks.push(chunk);
    }
    if (signature(before) !== signature(await handle.stat()) || size !== before.size || await realpath(path) !== resolved
      || resolvedRoot && await realpath(root!) !== resolvedRoot || signature(before) !== signature(await stat(resolved))) {
      throw new WorkflowError('FILE_CHANGED', '文件在读取期间发生变化');
    }
    const file_sha256 = hash.digest('hex');
    if (expectedHash && expectedHash.toLowerCase() !== file_sha256) throw new WorkflowError('FILE_CHANGED', '文件摘要与预期不符');
    return { info: { filename: name, size, file_sha256, content_type: mime[sourceExt] }, bytes: Buffer.concat(chunks, size) };
  } finally { await handle.close(); }
}
