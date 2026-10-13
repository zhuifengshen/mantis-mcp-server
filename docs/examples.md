# Workflow MCP 场景示例

示例编号仅为占位。所有写入都须在用户当前授权范围内，前置标识取实时 context，operation_id 每个新动作独立生成。

## 连续修复本人缺陷

1. 将当前仓库和 Mantis 项目对齐；`list_issues({project_id:44,assignee:"me",queue:"unresolved",limit:20})`。
2. 从本批选一个尚未处理的 ID，`get_issue_context({issue_id:123})` 确认仍归本人、未解决及项目匹配。
3. Coding Agent 修改代码并实际自测；失败或未运行则保留未解决，可 add_note 如实记录。
4. 自测通过后调用 `submit_fix`，带 fix_summary、passed self_test、operation_id、expected_revision。
5. succeeded 后记录本条完成，继续本批下一个候选。partial_success/unknown 留作待处理并按原操作核查，不算完成。
6. 本批结束需要更多候选时从第一页刷新。写入使结果集收缩，旧游标不能继续作为下一批入口；没有写入的连续扫描才沿游标续查。

正常单批 N 条只需 1+2N 次 MCP 调用；这是接口组合计数，不包含 REST 请求、Agent 测试、异常恢复、长时间刷新和批末查询，也不是实测性能提升。

## 超过 30 分钟的修复

读最小上下文：`get_issue_context({issue_id:123,sections:[],previous_revision:"最初标识"})`。仅 unchanged 可直接沿用原处理判断并使用新标识；changed/unavailable 先阅读最新事实。不要盲目替换标识强行登记。

## 新建缺陷并上传两个附件

1. 必要时读取 `get_project_context({project_id:44})` 的分类和版本。
2. report_issue 提交明确的预期与实际现象，保存成功返回的 issue_id、expected_revision。
3. upload_file 上传 `/本机绝对路径/截图.png`，使用新的 UUID 和上一步 revision。
4. 成功后用最新 revision 上传 `/本机绝对路径/复现.pdf`，使用另一个 UUID。
5. 分别报告建单与两个附件结果。第二个失败不回滚第一个，不重复 report_issue，也不把“已创建”写成“附件齐全”。

服务不会从缺陷正文中的路径自动读取文件；`MANTIS_UPLOAD_DIR` 限定文件读取范围，不授权上传目录。

## 延期及恢复

`postpone_issue` 记录延期原因及可选目标版本、复查日期。共享映射为 80/80，进入 postponed，退出 unresolved。使用 `list_issues({project_id:44,queue:"postponed"})` 复查。

恢复时调用 `reopen_issue({issue_id:123,reason_code:"resume_postponed",reason:"依赖已完成",expected_revision:"…",operation_id:"…"})`。无须编造复测失败；后续按实际需要受理、指派或修复。

## 状态成功但备注失败

保留原 submit_fix 输入和 operation_id，用 get_workflow_operation 核查。如果明确给出 retry_same_operation，纠正原拒绝原因后调用同一个 submit_fix，原输入不变，仅增加 `resume:true`。不要用 add_note 重新编写“恢复说明”，不要重复 PATCH，更不能因私有备注失败改成公开。

## 测试验收与版本管理

默认由测试人员在 Mantis 网页验收关闭。扩展开启时才有 close_issue，仍需本人的验收记录与实际权限。不得把研发 self_test 自动转换成测试 verification。

创建版本使用 create_version(project_id,name,operation_id)。读取项目 context 的 versions_revision，再用 update_version/release_version/delete_version；将其放入 expected_revision。release_version 的 next_version 使用明确名称，不自动推算版本号；第二步失败后仅按原操作恢复。
