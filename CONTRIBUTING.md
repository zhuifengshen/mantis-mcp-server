# 开发与贡献

源码与问题反馈位于 [GitHub](https://github.com/zhuifengshen/mantis-mcp-server)。请提供复现步骤、脱敏错误以及 Node.js、MantisBT 和本包版本，不要提交 API Key、真实缺陷正文或生产附件。

## 本地开发

```bash
git clone https://github.com/zhuifengshen/mantis-mcp-server.git
cd mantis-mcp-server
npm ci
npm run typecheck
npm test
npm run test:package
```

使用 Node.js 22.12+（开发使用22.x）。`npm run build` 生成 `dist/`；`npm run init` 可安装仅执行类型检查的 pre-push 钩子。

## 修改约定

- TypeScript 保持严格模式，REST 使用原生 fetch；stdio 的 stdout 只用于 MCP 协议，日志写入 stderr。
- 文档、工具说明和提交说明使用中文，工具名、参数名及协议字段保留英文。
- 输入和部署绑定使用严格校验，禁止任意 fields 透传；不根据客户端角色表替代服务端授权。
- 操作未知时保留账本并只读核查，不重发写入；增加回归用例时使用合成数据。
- 修改调用契约时遵循语义化版本，同步 package.json、package-lock.json、CHANGELOG.md 及迁移说明。
- 涉及真实服务的验证必须得到该实例所有者明确授权；仓库 CI 仅执行合成测试与安装包验证。

## 发布

按 [发布说明](docs/releasing.md)验证精确版本和安装包后发布，GitHub tag 使用 `v<package.json.version>`。npm 包名应属于维护者有权发布的 scope；保留 MIT 许可证和原作者版权声明。
