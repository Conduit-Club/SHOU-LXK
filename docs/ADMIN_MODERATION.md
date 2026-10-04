# LXK 管理员与本站内容管理

管理员入口为 `/admin`，登录后顶部会显示“管理”。需要先完成 `0007_admin_moderation.sql`，并以 Worker Secret 配置 `LXK_ADMIN_EMAILS`（逗号、分号或换行分隔的精确邮箱）。这个名单只管 LXK，与 SHOU-Auth 的 `ADMIN_EMAILS` 分开，不默认继承账号中心权限，也不把真实管理员邮箱写入源码或公开变量。

## 身份与权限

只有经过 OIDC 授权码、PKCE、state、nonce、签名、issuer、audience 和过期校验的可信资料能绑定管理员身份。邮箱与 `email_verified=true` 必须来自同一份完整的已验证 ID Token 或 subject 匹配的 UserInfo。客户端提交的邮箱、姓名、角色、账号 ID 都不能授予权限。

本站仍以 `issuer + subject` 定位用户。私有 `auth_users.verified_email_hash` 只保存规范化邮箱的 SHA-256 hash，不保存明文邮箱；邮箱 trim、转小写后精确匹配，不合并 Gmail 点号、别名或 `+` 后缀。每次会话读取都会从 D1 取得当前身份 hash 和封禁状态，并与当前服务端名单及可信 issuer 比对。页面只返回该用户是否能进入管理页，不返回 hash、subject 或名单。普通课程、教师及点评查询和首页公共 Cache 没有作者信息或管理身份数据。

`0007` 不会猜测旧账号邮箱，旧用户的 hash 初始为 NULL。**名单中的管理员必须退出 LXK 后重新登录一次**，通过新的可信回调绑定邮箱，才能看到管理入口。移除名单会让下一次请求失去管理权限，管理写入还会在其数据库事务内再次核对当前会话、身份和有效期。

## 删除、恢复与封禁

- 课程和教师点评分别分页管理，每页最多 20 条，可切换“公开中”和“已删除”。每个操作必须写理由（1–500 字），所有写入均要求 POST、同源 Origin、本站 CSRF token 和服务端管理员权限。
- 删除是可恢复的：在同一 D1 batch 事务内复制到私有 `moderation_review_archive`、移除活动点评并记审计。恢复将原 ID、正文、作者关联及发表时间放回活动表，再移除档案并记审计；任何失败全部回滚，不覆盖冲突点评。
- 两类活动点评的主键使用 `AUTOINCREMENT`。删除最高 ID 或归档全部点评以后，新点评也不会占用已删除 ID；恢复旧 ID 后的新 ID 继续递增。迁移会复制当前点评表并重建同名索引和计数触发器，原数据和计数不变。
- 公共查询仍只读活动表；现有触发器在删除/恢复的同一事务内维护 `site_stats.reviews` 和课程班级 `review_count`，不增加公开页查询或扫描。成功后清除当前数据中心的首页点评/统计缓存，其他地区最多约 60 秒显示旧首页；目录和详情直接读取当前数据。
- 封禁仅针对 LXK，保留已有点评。封禁状态与审计在同一事务内提交，数据库触发器撤销该用户所有本站会话；再次登录仍被拒绝。新评论和新会话的 INSERT 触发器在写入时核对封禁，防止 Turnstile 或 OIDC 处理期间发生并发封禁后继续写入。
- 解除封禁不会恢复旧会话，用户必须重新登录。管理员仍可恢复封禁用户的原点评；这一例外只允许与私有档案逐字段相同的原评论，不能当作新点评提交。
- 不能封禁自己或其他当前管理员，服务端及事务目标条件都复核这项保护。旧 `author_id=NULL` 点评可删、可恢复，但无法追溯到用户，界面明确禁止作者封禁。

管理页面和审计都使用 `private, no-store`。`moderation_events` 保存真实变化的操作 ID、操作者本站 ID、目标、动作、理由和 UTC 时间，并可分页查看；重复删除/恢复/封禁返回 409，不重复计数或产生虚假审计。生产 D1 备份包含私有身份与管理资料，按私有数据保管。

## 本地复现

使用隔离持久目录与 development OIDC client，禁止生产测试评论。已有 `0006` 库只应用本地 `0007`；新空库直接加载当前 `schema.sql`。本地 Auth capture 模式仍为 8788，LXK 为 5173，本地 `.dev.vars` 的 `LXK_ADMIN_EMAILS` 只填写测试邮箱。

```powershell
pixi run pnpm exec wrangler d1 migrations apply DB --local
pixi run check
pixi run lint
pixi run test
pixi run build
```

HTTP 检查顺序：测试邮箱邀请注册、验证邮箱、真实 OIDC 登录后 `/admin` 返回 200；游客 401、普通用户 403、错误 CSRF 和跨源 403；删除课程/教师点评、重复操作 409、恢复原编号、封禁作者使旧 Cookie 立即失效、被封作者旧点评可恢复、解封不恢复旧会话。检查分页、审计、`Cache-Control: private, no-store`，并从数据库核对计数。

`tests/moderation.test.mjs` 使用真实 Miniflare D1 覆盖权限、CSRF、事务、计数、缓存失效、ID 不重用、并发权限撤销、封禁写入保护和审计失败全回滚。`tests/auth.test.mjs` 验证可信邮箱绑定及两个资料来源不能错误拼接。

## 生产顺序

1. 以唯一新文件名导出当前生产 D1 并确认成功；查询迁移状态，只应用缺失的 `0007`，不重放历史点评或历史迁移。迁移会复制点评，因此存在一次性的读取/写入成本。
2. 将指定管理员邮箱写入 `LXK_ADMIN_EMAILS` Worker Secret；保留 OIDC 和 Turnstile 的生产配置与密钥。
3. 发布已审核、已测试的构建，仅少量验证公开页、游客管理拒绝与登录跳转。真实管理员重新登录后可自行进入 `/admin`；不代其生产注册或写测试点评。

```powershell
pixi run pnpm exec wrangler d1 migrations list DB --remote
pixi run pnpm exec wrangler d1 export DB --remote --output .wrangler/shou-courses-before-0007-<unique-time>.sql
pixi run pnpm exec wrangler d1 migrations apply DB --remote
pixi run pnpm exec wrangler secret put LXK_ADMIN_EMAILS
pixi run pnpm exec wrangler deploy --config wrangler.jsonc --keep-vars --strict --var MAINTENANCE_MODE:false
```

`0007` 的活动表与旧公开查询兼容。回退应用可以保留新增对象和封禁触发器，但旧应用没有删除/恢复/封禁 UI；不要为回退删掉档案、审计、封禁记录或数据库。LXK 封禁不修改认证中心用户状态，全中心停用仍由账号中心独立管理。
