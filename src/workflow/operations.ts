import { mkdir, open, readFile, rename, unlink, chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkflowError, type Step, type WriteResult } from './contracts.js';
import type { Entity } from '../services/projects.js';
import { digest } from './tokens.js';

const processStart = `${process.pid}:${Date.now() - Math.round(process.uptime() * 1000)}:${randomUUID()}`;
const retention = 7 * 86400_000;
export interface Operation {
  operation_id: string; action: string; user_id: number; project_id: number; issue_id?: number;
  request_hash: string; resolved_hash: string; binding: string; created_at: number; updated_at: number;
  plan: Entity; steps: Step[]; primary_response_hash?: string; after_hash?: string; completed_at?: number; result?: WriteResult;
}

export class Operations {
  private dir: string;
  constructor(root: string) { this.dir = join(root, 'operations'); }
  async initialize() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
  }
  async load(id: string): Promise<Operation | null> {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new WorkflowError('INVALID_INPUT', '操作编号无效');
    try {
      const record = JSON.parse(await readFile(join(this.dir, `${id}.json`), 'utf8')) as Operation;
      if (record.operation_id !== id || !Array.isArray(record.steps) || !record.plan || !record.request_hash
        || record.resolved_hash !== digest(record.plan)) throw new Error('invalid');
      return record;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new WorkflowError('RECOVERY_UNAVAILABLE', '操作账本不可读取或已损坏，禁止重新发送');
    }
  }
  expired(record: Operation) { return Date.now() - (record.completed_at ?? record.created_at) > retention; }
  async save(record: Operation) {
    await this.initialize();
    record.updated_at = Date.now();
    const temp = join(this.dir, `${record.operation_id}.${randomUUID()}.tmp`);
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
    finally { await handle.close(); }
    try {
      await rename(temp, join(this.dir, `${record.operation_id}.json`));
      const directory = await open(this.dir, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temp).catch(() => {}); }
  }
  async lock(key: string): Promise<(() => Promise<void>) | null> {
    await this.initialize();
    if (!/^[a-z0-9-]+$/i.test(key)) throw new WorkflowError('INVALID_INPUT', '锁对象无效');
    const path = join(this.dir, `${key}.lock`);
    const owner = { pid: process.pid, process_start: processStart, token: randomUUID() };
    const claim = async () => {
      try {
        const handle = await open(path, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); } finally { await handle.close(); }
        return async () => {
          const current = JSON.parse(await readFile(path, 'utf8').catch(() => '{}'));
          if (current.token === owner.token) await unlink(path);
        };
      } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return null; throw e; }
    };
    const release = await claim();
    if (release) return release;
    // 用独立回收锁串行化崩溃恢复。仍存活或 PID 已复用时保守地不抢锁。
    let reaper;
    try { reaper = await open(`${path}.reaper`, 'wx', 0o600); } catch { return null; }
    try {
      let old;
      try { old = JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
      if (!Number.isSafeInteger(old.pid) || old.pid <= 0) return null;
      try { process.kill(old.pid, 0); return null; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') return null; }
      await unlink(path);
      return await claim();
    } finally { await reaper.close(); await unlink(`${path}.reaper`).catch(() => {}); }
  }
  /** 仅清理已完成且过期的记录；未知、部分成功及活跃记录始终保留。 */
  async prune() {
    for (const name of (await readdir(this.dir)).filter(n => /^[a-f0-9-]{36}\.json$/i.test(n)).slice(0, 1000)) {
      const id = name.slice(0, -5);
      const release = await this.lock(`operation-${id}`);
      if (!release) continue;
      try { const r = await this.load(id); if (r?.result?.outcome === 'succeeded' && this.expired(r)) await unlink(join(this.dir, name)); }
      finally { await release(); }
    }
  }
}
