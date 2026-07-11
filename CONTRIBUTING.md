# 贡献指南

感谢关注 AgentCore。当前为精简版约定；完整 CONTRIBUTING 后续补充。

## 开始之前

1. 阅读 [`docs/02-架构/本地开发.md`](docs/02-架构/本地开发.md)，在本机跑通开发环境。
2. 改动前先看 [`docs/索引.md`](docs/索引.md) 的任务路由，定位相关设计文档。

## 开发与测试

提交 PR 前请在本地跑通相关门禁：

```bash
# 与 CI 同构的发布前门禁
pnpm release:gate

# 后端单测（按改动范围）
pnpm test:server
# 或：cd apps/server && uv run pytest
```

只改前端时，至少保证对应包的类型检查 / 单测通过；涉及协议 fold 时跑 `pnpm conformance`。

## Pull Request

- 说明**动机**（解决什么问题）与**做法**（改了什么、为何这样改）
- 关联相关 Issue（如有）
- 不要在公开讨论中粘贴密钥；安全问题见 [`SECURITY.md`](SECURITY.md)

## 许可证

贡献默认按 [Apache License 2.0](LICENSE) 授权。第三方资产约束见 [`NOTICE`](NOTICE)。
