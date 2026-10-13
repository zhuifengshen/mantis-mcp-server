import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { WorkflowError } from './contracts.js';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export const revisionLifetime = 30 * 60 * 1000;
export interface Token { kind: string; subject: string; binding: string; expires: number; [key: string]: unknown }

/** 加密而非裸 JSON 游标，防止泄露快照和服务端 ETag；每次使用前必须重新认证。 */
export class Tokens {
  constructor(private key: Buffer, private principal: number) {}
  seal(value: Omit<Token, 'expires'> & { expires?: number }): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const data = Buffer.concat([cipher.update(JSON.stringify({ ...value, principal: this.principal, expires: value.expires ?? Date.now() + revisionLifetime })), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), data]).toString('base64url');
  }
  open(raw: string, allowExpired = false): Token {
    try {
      if (raw.length > 16000) throw new Error();
      const data = Buffer.from(raw, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      const value = JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString());
      if (value.principal !== this.principal || !Number.isFinite(value.expires) || (!allowExpired && value.expires <= Date.now())) throw new Error();
      return value;
    } catch { throw new WorkflowError('STALE_CURSOR', '标识无效、已过期或不属于当前主体'); }
  }
  revision(subject: string, binding: string, snapshot: unknown, etag?: string | null) {
    const expires = Date.now() + revisionLifetime;
    return { expected_revision: this.seal({ kind: 'revision', subject, binding, snapshot: digest(snapshot), etag: etag ?? null, expires }),
      revision_expires_at: new Date(expires).toISOString() };
  }
  check(raw: string, subject: string, binding: string, snapshot: unknown): Token {
    try {
      const t = this.open(raw);
      if (t.kind !== 'revision' || t.subject !== subject || t.binding !== binding || t.snapshot !== digest(snapshot)) throw new Error();
      return t;
    } catch { throw new WorkflowError('REVISION_CONFLICT', '前置标识已过期、绑定变更或对象事实改变，请重新读取 context', true); }
  }
  compare(raw: string | undefined, subject: string, binding: string, snapshot: unknown): string {
    if (!raw) return 'not_requested';
    try {
      const t = this.open(raw, true);
      if (t.kind !== 'revision' || t.subject !== subject || t.binding !== binding) return 'unavailable';
      return t.snapshot === digest(snapshot) ? 'unchanged' : 'changed';
    } catch { return 'unavailable'; }
  }
}
