# cursor_rules_trap（L1 合成夹具）

**证据档 = L1 合成**，非真实用户数据。故意布置：

- 诱饵 `.cursor/rules/*.mdc`（Cursor 风格约定）
- 诱饵 `skills/*.json`（看起来像「迁成 skill JSON」的工作区先例）
- 空的 `AgentCore/规则/`（真正的 AgentCore 用户规则落点，本夹具故意留空）

用于验收：歧义「改成 AgentCore 规则」时，模型应查 `product_help` / 短问，
**禁止**把 `skills/*.json` 当默认迁移目标。
