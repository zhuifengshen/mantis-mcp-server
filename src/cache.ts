import { readFile, writeFile, unlink, mkdir, rename, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { MantisProject, MantisUser, MantisVersion, MantisCategory, MantisTag } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CachedProjectMeta {
  users: MantisUser[];
  versions: MantisVersion[];
  categories: MantisCategory[];
}

/** Workflow 展示缓存：构造参数只能来自首次认证后的凭据域，不导入旧 metadata.json。 */
export class ScopedMetadataCache {
  constructor(private subjectDir: string, private ttlSeconds: number) {}
  private path(projectId: number) { return join(this.subjectDir, 'metadata', `${projectId}.json`); }
  private async write(projectId: number, data: unknown) {
    const dir = join(this.subjectDir, 'metadata');
    await mkdir(dir, { recursive: true, mode: 0o700 }); await chmod(dir, 0o700);
    const temp = `${this.path(projectId)}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(data), { mode: 0o600 }); await rename(temp, this.path(projectId)); }
    finally { await unlink(temp).catch(() => {}); }
  }
  async save(projectId: number, sections: Record<string, unknown>) {
    await this.write(projectId, { timestamp: Date.now(), sections });
  }
  async load(projectId: number): Promise<Record<string, unknown> | null> {
    try {
      const file = JSON.parse(await readFile(this.path(projectId), 'utf8'));
      return Date.now() - file.timestamp < this.ttlSeconds * 1000 ? file.sections : null;
    } catch { return null; }
  }
  async patchVersions(projectId: number, versions: unknown[]) {
    let file;
    try { file = JSON.parse(await readFile(this.path(projectId), 'utf8')); } catch { return; }
    if (!file.sections?.versions) return;
    file.sections.versions = { ...file.sections.versions, items: versions };
    await this.write(projectId, file); // 保留原时间戳，不延长其他区块有效期。
  }
}

export interface CachedMetadata {
  timestamp: number;
  projects: MantisProject[];
  byProject: Record<number, CachedProjectMeta>;
  tags: MantisTag[];
}

interface CacheFile {
  timestamp: number;
  data: CachedMetadata;
}

// ---------------------------------------------------------------------------
// MetadataCache
// ---------------------------------------------------------------------------

export class MetadataCache {
  private readonly filePath: string;
  private readonly issueFieldsFilePath: string;
  private readonly ttlSeconds: number;
  private readonly cacheDir: string;

  constructor(cacheDir: string, ttlSeconds: number) {
    this.cacheDir = cacheDir;
    this.filePath = join(cacheDir, 'metadata.json');
    this.issueFieldsFilePath = join(cacheDir, 'issue_fields.json');
    this.ttlSeconds = ttlSeconds;
  }

  async isValid(): Promise<boolean> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const file = JSON.parse(raw) as CacheFile;
      const ageSeconds = (Date.now() - file.timestamp) / 1000;
      return ageSeconds < this.ttlSeconds;
    } catch {
      return false;
    }
  }

  async load(): Promise<CachedMetadata | null> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const file = JSON.parse(raw) as CacheFile;
      return file.data;
    } catch {
      return null;
    }
  }

  async loadIfValid(): Promise<CachedMetadata | null> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const file = JSON.parse(raw) as CacheFile;
      const ageSeconds = (Date.now() - file.timestamp) / 1000;
      if (ageSeconds >= this.ttlSeconds) return null;
      return file.data;
    } catch {
      return null;
    }
  }

  async save(data: CachedMetadata): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    const file: CacheFile = {
      timestamp: Date.now(),
      data,
    };
    await writeFile(this.filePath, JSON.stringify(file, null, 2), 'utf-8');
  }

  /** 仅更新已有缓存中的版本列表，保留原时间戳，避免延长其他元数据的有效期。 */
  async patchVersions(mutate: (projectId: number, versions: MantisVersion[]) => MantisVersion[]): Promise<void> {
    let file: CacheFile;
    try {
      file = JSON.parse(await readFile(this.filePath, 'utf-8')) as CacheFile;
    } catch {
      return;
    }
    for (const [projectId, meta] of Object.entries(file.data.byProject)) {
      meta.versions = mutate(Number(projectId), meta.versions);
    }
    await writeFile(this.filePath, JSON.stringify(file, null, 2), 'utf-8');
  }

  async invalidate(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch {
      // Already gone — that is fine
    }
  }

  async loadIssueFields(): Promise<string[] | null> {
    try {
      const raw = await readFile(this.issueFieldsFilePath, 'utf-8');
      const file = JSON.parse(raw) as { timestamp: number; fields: string[] };
      const ageSeconds = (Date.now() - file.timestamp) / 1000;
      if (ageSeconds >= this.ttlSeconds) return null;
      return file.fields;
    } catch {
      return null;
    }
  }

  getRemainingTtlSeconds(timestampMs: number): number {
    return Math.round(this.ttlSeconds - (Date.now() - timestampMs) / 1000);
  }

  async saveIssueFields(fields: string[]): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    const file = { timestamp: Date.now(), fields };
    await writeFile(this.issueFieldsFilePath, JSON.stringify(file, null, 2), 'utf-8');
  }
}
