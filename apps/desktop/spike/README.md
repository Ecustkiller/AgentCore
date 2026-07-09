# Desktop 实验区

临时原型、UI 试探、一次性验证脚本放这里，**不要**放进 `src/renderer/`（避免被路由、打包或 lint 误纳入产品树）。

| 规则 | 说明 |
|------|------|
| 生命周期 | 验证完即删，或提炼进 `src/` 后删 spike |
| 不进 conformance | spike 代码不参与 `pnpm conformance` |
| 命名 | 子目录用 `spike-{主题}`，如 `spike-graph-layout/` |

→ 产品代码组织见 [`项目结构.md` §五、§附录](/docs/02-架构/项目结构.md)。
