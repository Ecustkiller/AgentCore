# Cloudflare Access — 管理后台 `office.*`

在 API 鉴权（`AdminUser`）之外，为 `office.fashitianxia.xyz` 增加 **Zero Trust 身份门**。推荐作为公网暴露管理后台时的第一道防线。

## 前置

- 域名经 **Cloudflare Tunnel** 指向生产机 Nginx（见 `docs/05-平台与运维/部署与运维.md` §管理后台）
- Cloudflare 账号已接管 `fashitianxia.xyz` DNS

## 步骤（Dashboard）

1. **Zero Trust** → **Access** → **Applications** → **Add an application**
2. Type: **Self-hosted**
3. Application domain: `office.fashitianxia.xyz`（Path: 留空 = 整站）
4. Identity providers: 团队邮箱（Google Workspace / 一次性 PIN / 允许的邮箱域）
5. Policy: **Allow** → Include → `Emails ending in @yourcompany.com`（或指定运营者邮箱列表）
6. 保存后，未通过 Access 的浏览器访问 `office.*` 会先看到 Cloudflare 登录页

## 与 AgentCore 的关系

| 层 | 作用 |
|---|---|
| Cloudflare Access | 网络/身份：谁能打开 admin SPA |
| `/v1/auth/login` + `AdminUser` | 应用：谁能调用管理 API |
| CSRF + Cookie | 防跨站写操作（已实现） |

Access **不替代** 应用登录；两者叠加。

## 可选加固

- **Service Auth**（mTLS）仅在内网 Tunnel 段需要时启用
- **WAF** 规则：对 `/api/` 限制非预期国家/ASN（按运营地调整）
- 审计：Cloudflare Access logs → 定期抽查谁进了 office

## 验证

1. 隐身窗口打开 `https://office.fashitianxia.xyz` → 应出现 Access 登录
2. 通过 Access 后进入 admin 登录页 → 非 admin 账号仍 403
3. 未授权邮箱应被 Access 挡在应用外
