import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { MantisClient } from '../../src/client.js';
import { Projects, type Entity } from '../../src/services/projects.js';
import { Issues } from '../../src/services/issues.js';
import { Bindings, bindingSchema } from '../../src/workflow/bindings.js';
import { Context } from '../../src/workflow/context.js';
import { Executor } from '../../src/workflow/executor.js';
import { schemas } from '../../src/workflow/contracts.js';

export const deployment = bindingSchema.parse({ schema_version: 1, defaults: { note_visibility: 'instance_default', actions: {
  accept_issue: { status_id: 40, assigned_status_id: 50, resolution: 'preserve' }, submit_fix: { status_id: 80, resolution_id: 20 },
  close_issue: { status_id: 90, resolution: 'preserve' }, reopen_issue: { source: 'project_reopen_config' },
  reject_issue: { status_id: 80, resolutions_by_reason: { not_a_bug: 70, wont_fix: 90, cannot_reproduce: 40, cannot_fix: 50 } },
  postpone_issue: { status_id: 80, resolution_id: 80 },
} } });
export const configValues: Entity = {
  status_enum_string: '10:new,20:feedback,30:acknowledged,40:confirmed,50:assigned,80:resolved,90:closed',
  resolution_enum_string: '10:open,20:fixed,30:reopened,40:unable to duplicate,50:not fixable,60:duplicate,70:not a bug,80:suspended,90:wont fix',
  priority_enum_string: '30:normal,40:high', severity_enum_string: '50:minor,60:major', reproducibility_enum_string: '10:always,70:have not tried',
  view_state_enum_string: '10:public,50:private', bug_resolved_status_threshold: 80, bug_closed_status_threshold: 90,
  bug_reopen_status: 20, bug_reopen_resolution: 30, bug_submit_status: 10, default_bugnote_view_status: 10,
};
export const makeIssue = (id = 1, overrides: Entity = {}): Entity => ({ id, summary: `合成缺陷 ${id}`, description: '实际原文', project: { id: 44, name: 'Demo' },
  category: { id: 1, name: '测试' }, status: { id: 50 }, resolution: { id: 10 }, priority: { id: 30 }, severity: { id: 50 },
  handler: { id: 7, name: 'tester' }, reporter: { id: 7, name: 'tester' }, updated_at: '2026-10-01T00:00:00Z',
  notes: [], attachments: [], relationships: [], monitors: [], tags: [], custom_fields: [], ...overrides });
export interface Request { method: string; path: string; body?: Entity; url: URL; headers: Record<string, string> }
export class RestFixture {
  issues = new Map<number, Entity>([[1, makeIssue()]]);
  versions: Entity[] = [{ id: 1, name: '1.0', released: false, obsolete: false }];
  calls: Request[] = [];
  values = structuredClone(configValues);
  user: Entity = { id: 7, name: 'tester', email: 'not-for-output@example.invalid' };
  intercept?: (request: Request) => Response | undefined | Promise<Response | undefined>;
  private tick = 0;
  response(body: unknown, status = 200) { return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'X-Mantis-Version': '2.26.2' } }); }
  touch(issue: Entity) { issue.updated_at = new Date(Date.parse('2026-10-01T00:00:00Z') + ++this.tick * 1000).toISOString(); }
  fetch = async (urlString: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(urlString));
    const request = { method: init.method ?? 'GET', path: url.pathname.replace('/api/rest/', ''), url,
      body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers as Record<string, string> };
    this.calls.push(request);
    const override = await this.intercept?.(request);
    return override ?? this.apply(request);
  };
  apply(r: Request): Response {
    const { path, method, body = {} } = r;
    if (path === 'users/me') return this.response(this.user);
    if (path === 'config') return this.response({ configs: Object.entries(this.values).map(([option, value]) => ({ option, value })) });
    if (path === 'projects') return this.response({ projects: [{ id: 44, name: 'Demo' }] });
    if (path === 'projects/44') return this.response({ projects: [{ id: 44, name: 'Demo', categories: [{ id: 1, name: '测试' }] }] });
    if (path === 'projects/44/users') return this.response({ users: [this.user, { id: 8, name: 'other' }] });
    if (path === 'filters') return this.response({ filters: [{ id: 3, project: { id: 44 }, name: '已保存' }] });
    if (path.startsWith('projects/44/versions')) {
      const id = Number(path.split('/')[3]);
      if (method === 'GET') return this.response({ versions: this.versions });
      if (method === 'POST') {
        if (this.versions.some(v => v.name === body.name)) return this.response({ message: '名称重复' }, 400);
        const version = { id: Math.max(0, ...this.versions.map(v => v.id)) + 1, ...body };
        this.versions.push(version); return this.response({ version }, 201);
      }
      const version = this.versions.find(v => v.id === id);
      if (!version) return this.response({}, 404);
      if (method === 'PATCH') { Object.assign(version, body); return this.response({ version }); }
      this.versions = this.versions.filter(v => v.id !== id); return this.response(undefined, 204);
    }
    if (path === 'issues') {
      if (method === 'POST') {
        const issue = makeIssue(Math.max(...this.issues.keys(), 0) + 1, { ...body, status: { id: 10 }, handler: undefined, reporter: this.user });
        this.touch(issue); this.issues.set(issue.id, issue); return this.response({ issue }, 201);
      }
      let list = [...this.issues.values()];
      if (r.url.searchParams.get('filter_id') === 'assigned') list = list.filter(i => i.handler?.id === this.user.id && i.status.id < 80 && i.project.id === 44);
      const page = Number(r.url.searchParams.get('page') ?? 1), size = Number(r.url.searchParams.get('page_size') ?? 100);
      return this.response({ issues: list.slice((page - 1) * size, page * size) });
    }
    const match = path.match(/^issues\/(\d+)(?:\/(\w+)(?:\/(.+))?)?$/);
    if (!match) return this.response({}, 404);
    const issue = this.issues.get(Number(match[1]));
    if (!issue) return this.response({}, 404);
    const [, , section, itemId] = match;
    if (method === 'GET') return this.response({ issues: [issue] });
    if (!section && method === 'PATCH') {
      Object.assign(issue, body);
      if (body.handler && !body.status) issue.status = { id: 50 };
      this.touch(issue); return this.response({ issues: [issue] });
    }
    if (!section && method === 'DELETE') { this.issues.delete(issue.id); return this.response(undefined, 204); }
    if (section === 'notes' && method === 'POST') {
      const note = { id: issue.notes.length + 1, ...body, reporter: this.user };
      issue.notes.push(note); this.touch(issue); return this.response({ note }, 201);
    }
    if (section === 'files' && method === 'POST') {
      const file = body.files[0];
      let name = file.name;
      if (issue.attachments.some((f: Entity) => f.file_name === name)) name = name.replace(/(\.[^.]+)$/, '-2$1');
      issue.attachments.push({ id: issue.attachments.length + 1, file_name: name, size: Buffer.from(file.content, 'base64').length });
      this.touch(issue); return this.response(undefined, 201);
    }
    if (method === 'DELETE' && section && Array.isArray(issue[section])) {
      issue[section] = issue[section].filter((i: Entity) => (section === 'monitors' ? i.name : String(i.id)) !== decodeURIComponent(itemId));
      this.touch(issue); return this.response(undefined, 204);
    }
    return this.response({}, 404);
  }
  writes() { return this.calls.filter(c => c.method !== 'GET'); }
}
export async function harness(admin = false) {
  const dir = await mkdtemp(join(tmpdir(), 'mantis-workflow-test-'));
  const rest = new RestFixture(); vi.stubGlobal('fetch', vi.fn(rest.fetch));
  const client = new MantisClient('https://mantis.invalid', 'synthetic-test-key');
  const bindings = new Bindings(deployment);
  const context = new Context(new Projects(client, dir), new Issues(client), bindings, admin, '6.0.0');
  const capabilities = { nativeAssigned: true, verifiedUpdatedSort: false, conditionalRequests: false };
  const executor = new Executor(context, capabilities);
  return { dir, rest, client, context, executor, capabilities,
    async revision(id = 1) { return (await context.issue(schemas.get_issue_context.parse({ issue_id: id }), await context.projects.authenticate())).expected_revision; },
    async cleanup() { vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }); } };
}
