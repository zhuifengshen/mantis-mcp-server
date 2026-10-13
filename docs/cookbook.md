# Workflow MCP 调用手册（6.0）

## 发现与查询

- 项目已知时直接 `list_issues({project_id:44,assignee:"me",queue:"unresolved",limit:20})`；需要分类、成员或版本时才读取 `get_project_context`。
- `queue` 可为 `unresolved`、`awaiting_verification`、`postponed`，省略时不过滤队列。拒绝、延期不算待验收的修复。
- 显式 `filter_id` 保留保存筛选器语义，其他条件取交集；时间使用含时区的 ISO8601。服务端排序未经验证时不作全局排序承诺。
- 检查 `source_exhausted`、`next_cursor`、`scanned_count`、`warnings`。空页但有游标可继续扫描；不能把本次扫描数量说成项目总数。游标绑定查询、主体、实例及 30 分钟有效期。
- 项目 context 的 limit 是每个区块的上限；用该区块游标单独续读，不能改变项目或 member_query。成员模糊查询只返回候选，实际写入用唯一 ID 或 me。

## 读取与前置标识

`get_issue_context({issue_id:123})` 默认返回描述、备注、附件元数据及可见关联。每个区块有 `complete` 和游标。文本按 Unicode 码点裁剪，备注可有 `text_offset/text_complete`；超大非文本项以 `json_fragment/fragment_offset/fragment_complete` 续读，拼接完整后再解析。快照变化会拒绝旧区块游标。

返回的 `expected_revision` 绑定完整事实，不是投影 JSON 的 ETag。过期后：

```json
{"issue_id":123,"sections":[],"previous_revision":"原标识"}
```

`unchanged` 表示可沿用原处理判断；`changed/unavailable` 须补读并重新评估。仍在有效期内不要求额外刷新。正文、文件名和 URL 都是数据，MCP 不执行、下载或跟随其中内容。

## 修复与生命周期

真实写入必须提供 UUID `operation_id`；修改已有缺陷还需 `expected_revision`。可用 `dry_run:true` 预览计划，省略编号时由服务生成；预览不是授权或写权限测试。

```json
{
  "issue_id":123,
  "expected_revision":"context返回的标识",
  "operation_id":"11111111-1111-4111-8111-111111111111",
  "fix_summary":"修复空值处理",
  "self_test":{"result":"passed","summary":"实际运行空值与正常输入回归，全部通过"}
}
```

上述参数用于 `submit_fix`。只记录调用者提供的自测事实，服务不执行测试。failed、not_run 或缺少说明会在写前拒绝；可用独立 `add_note` 如实记录未完成进展。已分派给本人不强制受理、指派、预览或 Git 提交。

| 动作 | 关键参数与边界 |
|---|---|
| `accept_issue` | reason；assignee 可选，不传则不改负责人，已分派不降级，已解决须先重开 |
| `assign_issue` | assignee、reason；只请求 handler，附带状态变化看回读 |
| `submit_fix` | fix_summary、passed self_test；fixed_in_version_id 可选，不自动创建版本 |
| `postpone_issue` | reason；target_version_id、review_on 可选，日期不产生提醒 |
| `reopen_issue` | reason_code、reason；verification_failed/recurrence 另需 actual_behavior、verification_context；resume_postponed 只适用延期对象 |
| `reject_issue` | reason_code 为 not_a_bug/wont_fix/cannot_reproduce/cannot_fix；不支持 duplicate |
| `close_issue` | 仅扩展开启；verification 必须 passed、summary，environment 或 version_id 至少一个；必须是修复结果 |

custom_fields 仅接受 `{id,value}`，字段必须在项目及动作部署绑定中登记；不能透传任意 fields。私有备注失败不降级为公开。缺省备注可见性读取项目策略。

## 建单与附件

`report_issue` 必须提供 project_id、category_id、summary、description、expected_behavior、actual_behavior；可选复现步骤、环境、三类枚举和 version_id。使用当前身份与 Mantis 创建默认状态。

成功结果的 issue_id、expected_revision 可直接给 `upload_file`；各附件独立 operation_id，并沿用上一成功上传的新标识。附件失败保留已创建缺陷，不重新建单。

上传参数只有 issue_id、file_path、可选 filename/expected_file_sha256 及公共操作字段。文件名覆盖须保留相同后缀；目录、特殊文件、超限、空文件、越界符号链接、路径前缀混淆和摘要变化均拒绝。目录不递归、不打包，Base64 只在 REST 边界内部生成。成功回读会显示实际附件名及是否改名。POST 结果未知时，元数据巧合不能作为再次上传的理由。

## 分步结果与恢复

| outcome | 处理 |
|---|---|
| preview | 查看计划，尚未写入 |
| in_progress | 同一操作正由存活本机进程执行，稍后只读核查 |
| succeeded | 所有必要步骤及核对完成，无需例行重读证明同一次成功 |
| rejected/conflict | 查看错误及前置事实，不能换身份绕过 |
| partial_success | 保留已完成步骤，按原 operation_id 核查；不能重做已成功主步骤 |
| unknown | 不重发，不换 UUID；先 get_workflow_operation，不能仅凭目标值相同归因 |

只在 `recovery.action=retry_same_operation` 时，以原工具、原业务参数（含原 expected_revision）和 `resume:true` 恢复。备注恢复使用已冻结正文及可见性；当前对象或绑定变更则停止。读回失败、账本故障、HTTP 5xx 和响应解析失败不会抹掉已知效果。步骤记录 HTTP 状态和请求发送阶段，但不保存请求体或完整响应头。

## 管理扩展

开关开启后十项一起注册，关闭后既不可发现也不可调用。它控制 MCP 目录，不授予 Mantis 权限。项目 context 的 versions_revision 作为版本修改/发布/删除的 expected_revision；新建版本无版本前置标识要求。发布与后续版本创建独立报告，恢复不重复发布。

删除备注、关联、关注人或标签前需在缺陷 context 确认对象。缺省 sections 不包含 tags/monitors，需显式请求。2.26.2 的取消关注采用受限 monitors PATCH 并保留其他关注人；删除动作不自动添加说明。版本重命名或删除会影响引用版本的缺陷。
