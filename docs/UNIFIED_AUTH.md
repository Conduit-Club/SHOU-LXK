# SHOU-Auth 统一认证

LXK 使用 `https://auth.shoumc.com/api/auth` 的 OIDC 服务。注册、登录、密码、邮箱验证与 Passkey 都在账号中心完成；LXK 只保存本网站身份和登录会话。课程、教师及已有点评继续公开浏览，新点评要求已登录、已验证邮箱的账号，并保留 Cloudflare Turnstile。

## 授权流程与配置

`/auth/login` 与 `/auth/register` 使用授权码、S256 PKCE、随机 state 和 nonce。注册请求增加标准 `prompt=create`，由账号中心打开注册流程。登录后回调 `/auth/callback`，返回本网站 `returnTo` 指定的原课程或教师页面。外站地址、反斜杠、控制字符、规范化后以 `//` 开头的路径及认证路由都不能成为返回目的地。

openid-client 通过 issuer discovery 获取端点并校验 issuer。本站使用 confidential client 的 `client_secret_basic`；交换时要求 ID Token，检查 state、nonce、签名、issuer、audience 与过期时间。`enableNonRepudiationChecks` 明确启用 JWKS 签名验证。每次登录都请求认证中心的最新 UserInfo，要求 subject 与已验证 ID Token 一致；邮箱与验证标志来自同一 UserInfo，`email_verified` 必须为 `true`。显式未验证的 ID Token 也会被拒绝。

| Worker 配置             | 生产值或要求                                           |
| ----------------------- | ------------------------------------------------------ |
| `OIDC_ISSUER`           | `https://auth.shoumc.com/api/auth`，未设置时采用该地址 |
| `OIDC_CLIENT_ID`        | 在账号中心登记的 LXK 专属 confidential client          |
| `OIDC_CLIENT_SECRET`    | Worker Secret，不放仓库、前端或命令行参数              |
| `OIDC_REDIRECT_URI`     | `https://lxk.shoumc.com/auth/callback`，必须精确登记   |
| `OIDC_ALLOW_LOCAL_HTTP` | 生产不设置；只在明确的 loopback 本地联调设 `true`      |

scope 固定为 `openid profile email`，不申请 `offline_access`。回调必须属于当前应用 origin；缺少配置或配置不安全时不开始授权、不建立会话。账号中心资料入口为 `https://auth.shoumc.com/account`。

## 本站会话与点评

`auth_users` 以 `issuer + subject` 唯一对应账号，保存 Auth 的唯一用户名、受限头像 URL、中心角色和角色失效时间；邮箱不作为永久身份，也不保存明文到本站数据库。旧邮箱 hash 保留在私有数据中，不再授予权限，`LXK_ADMIN_EMAILS` 不生效。中心角色的权限边界见 [ADMIN_MODERATION.md](ADMIN_MODERATION.md)。`auth_sessions` 保存 SHA-256 会话 token hash、用户 ID、独立 CSRF token 和绝对有效期。浏览器只持有随机 256-bit 不透明 token，Cookie 为 `__Host-lxk-session`，使用 `Path=/; HttpOnly; Secure; SameSite=Lax`，不设置 Domain。

最新 UserInfo 必须提供 `username`、`roles` 和 UNIX 秒 `roles_checked_at`。用户名必须是 Auth 已规范化且不可更改的 2–24 字唯一用户名；缺少用户名的旧本站会话仍可浏览、退出，发表区会提示重新登录并补充资料，不回填“海大同学”。头像只接受与可信 issuer 同 origin 的 `/api/profile/avatar/<64位小写SHA256>.png`，其他 URL 不展示；旧头像失效时回退字符图标。管理员有效期取中心检查时间加 3600 秒、当前时间加 3600 秒和签名 ID Token `exp` 的最早值。未刷新管理员权限的普通会话仍可继续浏览，管理操作要求重新登录验证。

会话为 **8 小时绝对期限**，普通浏览不延长期限，也不每次访问账号中心。没有会话 Cookie（或格式不合法）的浏览请求不执行认证 SQL；有效 Cookie 通过主键和用户索引查询本站会话，同一请求只查询一次。页面与 SvelteKit 数据响应使用 `Cache-Control: private, no-store` 和 `Vary: Cookie`；首页 Cache API 继续只缓存公共 JSON，绝不放账号、CSRF、作者关联或 Cookie。

登录事务在 D1 保存 10 分钟，state 与独立 `__Host-lxk-login` 浏览器 Cookie 的 hash 绑定。回调用原子 `DELETE ... RETURNING` 消费事务，成功、provider 拒绝或令牌校验失败都不能重试该事务；另一浏览器无法消费。开始新的登录会替换当前登录 Cookie，因此同一浏览器应顺序完成授权。每次开始登录最多清理 50 条过期事务和 50 条过期会话；过期检查不依赖清理是否及时。

新课程/教师点评将 `author_id` 写为服务端会话用户 ID，不能由表单指定作者。写请求要求同源 Origin、本站 CSRF token、已完成用户名资料的有效会话以及原有 Turnstile 的 hostname/action 校验。默认 `visibility=anonymous`：公开查询固定投影“匿名用户”和 NULL 头像。选择 `visibility=username` 时，用户名与头像快照只来自服务端可信会话，表单提交的姓名、头像和账号 ID 都不会被采用。快照随删除/恢复完整保留；作者替换或移除头像后旧图片可能失效，界面回退字符图标。

旧点评不猜测作者；已有归属、原文与旧资料都保留，新增匿名字段默认开启。公开查询和公共缓存从不包含 `author_id`、subject、邮箱、封禁状态或管理资料。删除本站用户时，点评内容和已公开署名快照仍保留，私有作者关联置空。

退出使用 `POST /auth/logout`，校验 Origin 与 CSRF 后撤销本站会话、删除 Cookie。**退出本站不会退出账号中心；中心退出或禁用账号也不会立即撤销已有 LXK 会话。** 现有本站会话最多继续有效 8 小时。后续本站管理阶段已加入管理员权限和 LXK 封禁；本站封禁立即撤销本地会话并禁止新点评，详见 [内容管理](ADMIN_MODERATION.md)。中心实时撤销同步、全站退出和“我的点评”仍未加入。

## 本地联调

使用独立 development client，回调精确登记为 `http://localhost:5173/auth/callback`；认证服务为 `http://localhost:8788/api/auth`。复制 `.dev.vars.example` 并填写 development secret；只有 issuer 和 callback 都为 loopback、且显式设置 `OIDC_ALLOW_LOCAL_HTTP=true` 时才容许 HTTP。开发 Cookie 名为 `lxk-dev-session` 与 `lxk-dev-login`。

本地测试使用 Auth capture 邮件模式、独立 D1 持久目录和官方 Turnstile 测试键。不要将测试账号、测试评论写入生产。新空库执行 `schema.sql`；已有本地库应用缺失的 `0006`、`0007`、`0008`。

```powershell
pixi run pnpm exec wrangler d1 migrations apply DB --local
pixi run check
pixi run lint
pixi run test
pixi run build
```

## 上线顺序与回退

1. 在 SHOU-Auth 登记 LXK 独立客户端：准确回调、`client_secret_basic`、`requirePKCE=true`、`openid profile email`、生产和本地客户端分开；验证标准 `prompt=create` 注册与 verified claims。
2. 唯一文件名备份 LXK 生产 D1，查询迁移状态，仅应用缺失迁移。已完成 `0007` 的库只需 `0008_profiles_and_review_visibility.sql`；新增字段默认匿名且无中心角色，不归属历史点评、不批量改旧用户名、不重放数据。
3. 配置上述 OIDC 变量和客户端 Worker Secret，保留现有 Turnstile 变量/密钥。先发布 Auth，再发布已审核的 LXK 构建。
4. 只做少量生产公开页、登录跳转、注册跳转与无效回调检查；完整注册、登录、发点评和退出在隔离本地数据库验证。

```powershell
pixi run pnpm exec wrangler d1 migrations list DB --remote
pixi run pnpm exec wrangler d1 export DB --remote --output .wrangler/shou-courses-before-0006-<unique-time>.sql
pixi run pnpm exec wrangler d1 migrations apply DB --remote
pixi run pnpm exec wrangler secret put OIDC_CLIENT_SECRET
pixi run build
pixi run pnpm exec wrangler deploy --config wrangler.jsonc --keep-vars --strict --var MAINTENANCE_MODE:false
```

迁移与之前公开应用兼容，可回退应用而保留新增表/列。回退旧应用会恢复旧版本的匿名写入行为，应由维护者明确选择；不要为回退删除认证数据或重放结构迁移。数据库故障或配额耗尽时沿用维护开关，数据库未准备好之前不恢复访问。

自动测试覆盖浏览器绑定、PKCE、回调重放、签名/issuer/audience/nonce/expiry 拒绝、未验证邮箱、UserInfo subject、会话旋转/过期/退出、CSRF、匿名零认证查询、响应缓存隔离、作者写入与旧数据迁移兼容。
