# 维护者发布流程

npm：`@youcloud/mantis-mcp-server`；公开源码：`zhuifengshen/mantis-mcp-server`。安装命令保持 `mantis-mcp-server`。发布必须有维护者授权，不发布任何凭据、内部验收记录或真实服务测试附件。

## 准备精确版本

1. 按语义化版本同步 package.json、package-lock.json、CHANGELOG.md、README 和 `docs/releases/v<版本>.md`。
2. 执行 `npm ci`、`npm run typecheck`、`npm test`、`npm run test:package`、`npm audit --audit-level=high`。
3. 检查 `artifacts/package-verification.json` 中的文件清单和 SHA-256。安装包须含编译产物、MIT许可证和用户文档，不包含源码测试、操作脚本、`.env` 或内部记录。
4. 核对真实普通用户部署的权限和工作流配置；离线包验证不替代部署验收。

`test:package` 会自动构建，然后在独立目录只安装生产依赖，使用 npm 生成的命令入口完成 MCP 握手。产物包括 `.tgz`、对应 `.sha256` 及验证记录；不要在验证后替换产物。

## 发布 npm

首次发布或本地人工发布先执行 `npm login --registry=https://registry.npmjs.org`，用 `npm whoami` 核对身份及 `youcloud` scope权限。不要将 Token 放进提交或命令行明文参数。

```bash
npm publish ./artifacts/youcloud-mantis-mcp-server-6.0.0.tgz --access public --tag latest --registry=https://registry.npmjs.org
npm view @youcloud/mantis-mcp-server@6.0.0 version dist.integrity --registry=https://registry.npmjs.org
```

只发布已验证的 tarball，不在发布时从另一个工作区重新打包。若 npm 要求双因素验证，按官方登录/发布流程完成；未确认成功时先查询远端版本，不重复发布或修改版本绕过错误。

## GitHub Release

将经核对的公开源码推送到 GitHub，然后创建对应 `v<版本>` 标签。`GitHub 发布` 工作流核对标签、运行检查与安装验证，并上传 `.tgz`、SHA-256及验证记录。工作流使用仓库自身的 `GITHUB_TOKEN`，不会自动发布 npm；npm 发布是前述明确步骤。

首次启用 fork 的 GitHub Actions 时若平台要求维护者确认，应在仓库 Actions 页面启用。远端工作流未成功前，不能将本地测试视为 GitHub Release 已完成。后续按标签重跑时先检查已有 Release，避免覆盖已发布资产。

维护内部开发仓库的团队应使用基于公开历史的发布快照，保留内部记录在内部仓库；不要直接将未审查的内部历史推送到公开仓库。

流程参考：[npm 打包](https://docs.npmjs.com/cli/v10/commands/npm-pack/)、[GitHub Release](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)、[GITHUB_TOKEN](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token)。
