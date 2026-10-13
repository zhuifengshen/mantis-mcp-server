import { Bindings } from './bindings.js';
import { digest } from './tokens.js';
import { WorkflowError, problem, type Input } from './contracts.js';
import { Projects, minimalUser, type Entity, type Session } from '../services/projects.js';
import { Issues, facts, visibleCollection } from '../services/issues.js';
import { uploadPolicy } from '../services/files.js';
import type { ProjectRules } from './bindings.js';

export class Context {
  constructor(readonly projects: Projects, readonly issues: Issues, readonly bindings: Bindings, readonly admin: boolean, readonly version: string) {}
  bindingRevision(rules?: ProjectRules) { return digest({ deployment: this.bindings.revision, rules: rules ?? null }); }
  async optionalRules(projectId: number): Promise<ProjectRules | undefined> {
    try { return await this.projects.rules(projectId); }
    catch { return undefined; }
  }
  async state(issueId: number) {
    const { issue, etag, emptyArraysOmitted } = await this.issues.get(issueId);
    const rules = await this.optionalRules(issue.project.id);
    return { issue, etag, emptyArraysOmitted, rules, binding: this.bindingRevision(rules) };
  }
  revision(session: Session, issue: Entity, binding: string, etag?: string | null) {
    return session.tokens.revision(`issue:${issue.id}`, binding, issue, etag);
  }
  async project(input: Input, session: Session): Promise<Entity> {
    let cursor = input.cursor ? session.tokens.open(input.cursor) : undefined;
    const subject = input.project_id ? `project:${input.project_id}` : 'projects';
    const query = digest({ project_id: input.project_id, member_query: input.member_query, limit: input.limit });
    if (cursor && (cursor.kind !== 'project_cursor' || cursor.subject !== subject || cursor.query !== query
      || cursor.binding !== this.bindings.revision || input.sections && (input.sections.length !== 1 || input.sections[0] !== cursor.section))) {
      throw new WorkflowError('STALE_CURSOR', '项目区块游标与查询不符');
    }
    const page = (section: string, items: Entity[]) => {
      const offset = cursor ? Number(cursor.offset) : 0;
      const data = items.slice(offset, offset + input.limit);
      const next = offset + data.length < items.length ? session.tokens.seal({ kind: 'project_cursor', subject, query,
        binding: this.bindings.revision, section, offset: offset + data.length }) : null;
      return { availability: 'available', source: 'mantis_rest', fetched_at: new Date().toISOString(), items: data, next_cursor: next };
    };
    if (!input.project_id) {
      if (input.sections?.length || input.member_query) throw new WorkflowError('INVALID_INPUT', '发现模式仅分页返回项目，请选择项目后读取区块');
      return { schema_version: 1, current_user: session.user, projects: page('projects', await this.projects.list()),
        mcp_version: this.version, mantis_version: session.mantisVersion, extensions_enabled: this.admin };
    }
    const project = await this.projects.get(input.project_id);
    const sections = cursor ? [String(cursor.section)] : input.sections ?? ['categories', 'versions', 'enums', 'workflow', 'uploads'];
    const output: Entity = { schema_version: 1, project: { id: project.id, name: project.name }, current_user: session.user,
      extensions_enabled: this.admin, sections: {}, warnings: [], versions_revision: null };
    const rules = await this.optionalRules(project.id);
    if (!rules) output.warnings.push('PROJECT_CONFIG_UNAVAILABLE');
    Object.assign(output, this.bindings.availability(project.id, rules, this.admin));
    for (const section of sections) {
      try {
        let data: unknown;
        if (section === 'categories') {
          if (!Array.isArray(project.categories)) throw new WorkflowError('SERVICE_UNAVAILABLE', '项目分类不可读取');
          output.sections[section] = page(section, project.categories); continue;
        }
        if (section === 'versions') {
          const versions = await this.projects.versions(project.id);
          output.sections[section] = page(section, versions);
          if (this.admin) output.versions_revision = session.tokens.revision(`versions:${project.id}`, this.bindings.revision, versions).expected_revision;
          continue;
        }
        if (section === 'members') {
          let members = await this.projects.members(project.id);
          if (input.member_query) { const q = input.member_query.toLocaleLowerCase(); members = members.filter(m => [m.name, m.real_name].some(v => v?.toLocaleLowerCase().includes(q))); }
          output.sections[section] = page(section, members); continue;
        }
        if (section === 'filters') {
          const body = (await this.projects.client.request<Entity | Entity[]>('GET', 'filters')).body;
          const filters = Array.isArray(body) ? body : body?.filters;
          if (!Array.isArray(filters)) throw new WorkflowError('SERVICE_UNAVAILABLE', '筛选器不可读取');
          output.sections[section] = page(section, filters.filter((f: Entity) => !f.project?.id || f.project.id === project.id)); continue;
        }
        if (section === 'enums') {
          if (!rules) throw new WorkflowError('WORKFLOW_MAPPING_UNCONFIGURED', '项目枚举不可读取');
          data = rules.enums;
        }
        if (section === 'workflow') {
          if (!rules) throw new WorkflowError('WORKFLOW_MAPPING_UNCONFIGURED', '项目配置不可读取');
          const targets: Entity = {};
          for (const action of output.supported_actions) {
            try { targets[action] = this.bindings.target(project.id, action, rules); } catch { /* 无状态目标的动作不需要绑定。 */ }
          }
          data = { binding_revision: this.bindingRevision(rules), actions: targets, note_visibility: this.bindings.forProject(project.id).note_visibility,
            custom_fields_by_action: this.bindings.forProject(project.id).custom_fields_by_action, concurrency_mode: 'snapshot_precheck',
            verification_url: `${session.baseUrl}/view_all_bug_page.php?project_id=${project.id}` };
        }
        if (section === 'uploads') data = uploadPolicy;
        if (section === 'custom_fields') throw new WorkflowError('INTROSPECTION_UNAVAILABLE', '当前适配器不能可靠读取项目自定义字段定义；动作字段以部署绑定为准');
        output.sections[section] = { availability: 'available', source: section === 'uploads' ? 'deployment_policy' : 'mantis_rest_and_deployment',
          fetched_at: new Date().toISOString(), data, next_cursor: null };
      } catch (e) {
        const error = problem(e);
        output.sections[section] = { availability: error.code === 'MANTIS_FORBIDDEN' ? 'forbidden' : 'unavailable', source: 'mantis_rest',
          fetched_at: new Date().toISOString(), next_cursor: null, error };
      }
    }
    await this.projects.cacheDisplay(project.id, output.sections);
    return output;
  }
  async issue(input: Input, session: Session): Promise<Entity> {
    const { issue, etag, emptyArraysOmitted } = await this.issues.get(input.issue_id);
    const rules = await this.optionalRules(issue.project.id);
    const binding = this.bindingRevision(rules);
    const snapshot = digest(issue);
    const c = input.cursor ? session.tokens.open(input.cursor) : undefined;
    if (c && (c.kind !== 'issue_cursor' || c.subject !== `issue:${issue.id}` || c.binding !== binding || c.snapshot !== snapshot
      || input.sections && (input.sections.length !== 1 || input.sections[0] !== c.section))) throw new WorkflowError('STALE_CURSOR', '缺陷已变化或续读区块不匹配');
    const sections: string[] = c ? [String(c.section)] : input.sections ?? ['description', 'notes', 'attachments', 'relationships'];
    const output: Entity = { schema_version: 1, issue: facts(issue, session.baseUrl), sections: {}, ...this.revision(session, issue, binding, etag),
      revision_comparison: session.tokens.compare(input.previous_revision, `issue:${issue.id}`, binding, issue), concurrency_mode: 'snapshot_precheck',
      ...this.bindings.availability(issue.project.id, rules, this.admin), warnings: ['CONCURRENCY_PRECHECK_ONLY', ...(!rules ? ['PROJECT_CONFIG_UNAVAILABLE'] : [])] };
    let budget = input.max_chars;
    const title = Array.from(String(issue.summary ?? ''));
    const titleBudget = Math.min(1000, Math.floor(budget / 4));
    output.issue.summary = title.slice(0, titleBudget).join(''); budget -= Math.min(title.length, titleBudget);
    if (title.length > titleBudget) output.warnings.push('SUMMARY_TRUNCATED_SEE_DESCRIPTION_SECTION');
    for (const section of sections) {
      let source: Entity[] | undefined;
      if (section === 'description') source = ['summary', 'description', 'steps_to_reproduce', 'additional_information']
        .filter(k => typeof issue[k] === 'string').map(field => ({ field, text: issue[field] }));
      else source = visibleCollection(issue, section, emptyArraysOmitted);
      if (!source) { output.sections[section] = { availability: 'unavailable', complete: false, next_cursor: null }; continue; }
      const items: Entity[] = [];
      let index = c ? Number(c.index) : 0, offset = c ? Number(c.offset) : 0, chars = 0;
      for (; index < source.length && budget > 0; index++) {
        const raw = source[index];
        let item: Entity;
        if (section === 'notes') item = { id: raw.id, reporter: minimalUser(raw.reporter), text: raw.text, view_state: raw.view_state,
          updated_at: raw.updated_at, view_url: `${session.baseUrl}/view.php?id=${issue.id}#bugnote${raw.id}` };
        else if (section === 'attachments') item = { id: raw.id, filename: raw.file_name ?? raw.filename, size: raw.size, content_type: raw.content_type,
          download_url: `${session.baseUrl}/file_download.php?file_id=${raw.id}&type=bug`, view_url: output.issue.view_url };
        else if (section === 'monitors') item = minimalUser(raw)!;
        else if (section === 'relationships') {
          // 关联信息不默认证明目标可见；只从成功读取的目标提取摘要。
          const related = raw.issue?.id ?? raw.target_id;
          try { const target = (await this.issues.get(related)).issue; item = { id: raw.id, type: raw.type, issue: { id: target.id, summary: target.summary } }; }
          catch { item = { id: raw.id, availability: 'unavailable' }; }
        } else item = { ...raw };
        const isText = section === 'description' || section === 'notes';
        const overhead = isText ? Array.from(JSON.stringify({ ...item, text: '' })).length : 0;
        if (overhead >= budget) break;
        const content = isText ? String(item.text ?? '') : JSON.stringify(item);
        const points = Array.from(content);
        const slice = points.slice(offset, offset + budget - overhead).join('');
        const used = Array.from(slice).length;
        const complete = offset + used >= points.length;
        if ('text' in item) items.push({ ...item, text: slice, text_offset: offset, text_complete: complete });
        else if (complete && offset === 0) items.push(item);
        else {
          items.push({ id: item.id ?? null, json_fragment: slice, fragment_offset: offset, fragment_complete: complete });
          output.warnings.push('ITEM_JSON_FRAGMENT_CONTINUE_WITH_CURSOR');
        }
        budget -= used + overhead; chars += used;
        if (!complete) { offset += used; break; }
        offset = 0;
      }
      const complete = index >= source.length;
      output.sections[section] = { availability: 'available', items, complete, returned_count: items.length, returned_chars: chars,
        next_cursor: complete ? null : session.tokens.seal({ kind: 'issue_cursor', subject: `issue:${issue.id}`, binding, snapshot, section, index, offset }) };
    }
    return output;
  }
}
