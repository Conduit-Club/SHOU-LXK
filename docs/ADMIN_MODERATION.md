# LXK 管理模式与内容管理

认证中心的已验证管理员登录后，顶部显示“管理”与“管理模式”开关。`/admin` 提供完整搜索筛选和操作审计；开启管理模式后，点评搜索列表、课程和老师详情也可原位删除、恢复及管理作者。开关保存为本站 HttpOnly Cookie，导航时保留；它仅控制界面，不授予权限。

## 中心身份与短期权限

需要先完成 `0007_admin_moderation.sql` 与 `0008_profiles_and_review_visibility.sql`。管理员只来自 SHOU-Auth 最新的认证 UserInfo `roles: ["admin"]`；Auth 统一维护管理员资格。旧 `LXK_ADMIN_EMAILS` 已停止使用，保留该 Secret 也不会给用户授权。

登录回调完成授权码、PKCE、state、nonce、签名、issuer、audience 与过期校验后，使用 access token 请求最新 UserInfo，并核对稳定 subject。用户名、头像、邮箱验证和角色来自同一完整的可信响应，不拼接客户端资料。本站仍以 `issuer + subject` 定位用户，不用姓名或邮箱作永久身份。

普通会话最多有效 8 小时；管理权限只保留到 `min(roles_checked_at + 300, 当前时间 + 300, 已验证 ID Token exp)`。每次管理读取都从 D1 核对角色和有效期，每次写入还会在 batch 事务内复核当前会话、中心角色、issuer、封禁与有效期。权限过期后顶部显示“验证管理权限”，用户须重新登录，让中心重新确认角色。中心撤销资格在最后一次确认后至多约 5 分钟生效，没有无限期缓存管理身份。

旧资料的姓名和邮箱 hash 保留在私有存储中，新增角色默认为普通用户，用户名默认为 NULL。旧本站会话可继续浏览、退出，发表点评前须重新登录并补充唯一用户名。页面不返回 email hash、subject 或管理员名单。

## 搜索与原位操作

完整管理面板和开启模式的点评目录可按标题/正文、课程或教师、作者用户名/本站编号、点评类型、公开/已删除、账号关联和作者封禁状态组合筛选。文本使用参数化字面子串搜索；`%`、`_` 不变成 SQL 通配符。列表与审计均分页，每页最多 20 条，分页保留筛选。课程详情只加载所属课程和选中班级的点评，教师详情只加载该教师的点评；普通用户伪造开关或 `status=deleted` 也不能看到私有档案。

每条点评提供折叠的管理操作，避免遮挡阅读。历史无账号关联点评可删除、恢复，无法封禁作者。匿名点评的公开称呼固定为“匿名用户”，无头像；管理员仍可读取其私有作者关联进行封禁，不会把这些资料加入公共缓存。

- 每个操作必须写理由（1–500 字），要求 POST、同源 Origin、本站 CSRF 和当前服务端管理员权限。
- 删除在同一 D1 batch 事务内复制到私有 `moderation_review_archive`，移除活动点评并记审计。恢复原 ID、正文、归属、发表时间、匿名选择及公开快照，移除档案并记审计；任何失败全部回滚，不覆盖冲突点评。
- 活动点评主键使用 AUTOINCREMENT，归档最高编号后新点评也不会占用它。现有计数触发器在删除/恢复事务内维护站点和班级计数。
- 公共查询只读活动表。成功后清除本数据中心首页点评/统计缓存；其他中心最多约 60 秒显示旧首页，目录与详情直接读取当前数据。管理模式查询独立于公共缓存；游客公开页不新增管理 SQL。
- 封禁仅针对 LXK，保留已有点评；状态、审计和会话撤销同事务提交。新会话和点评的 INSERT 触发器在写入时复核封禁，阻止 OIDC 或 Turnstile 处理中的并发封禁绕过。
- 解封不恢复旧会话，用户须重新登录。管理员可恢复被封禁作者逐字段相同的原点评；该例外同时检查匿名选择和公开资料，不允许修改为新的署名点评。
- 不能修改自己的封禁状态，也不能封禁可信中心管理员；服务端与事务目标条件双重复核。重复删除、恢复、封禁返回 409，不重复计数或产生虚假审计。

所有页面响应均 `private, no-store`。`moderation_events` 保存真实变化的操作 ID、操作者本站编号、目标、动作、理由与 UTC 时间。生产备份包含私有身份、档案和审计，按私有数据保管。

## 本地验证

测试使用隔离 D1、模拟签名 OIDC 与官方 Turnstile 测试键，不写生产测试账号或点评。现有库仅应用缺失迁移；新空库直接加载当前 `schema.sql`。

```powershell
pixi run pnpm exec wrangler d1 migrations apply DB --local
pixi run check
pixi run lint
pixi run test
pixi run build
```

`tests/moderation.test.mjs` 验证权限、CSRF、事务、计数、缓存失效、ID 不重用、并发撤权与审计失败回滚。`tests/review-visibility.test.mjs` 验证匿名公开投影、伪造开关拒绝、真实身份提交、历史存储保留、组合筛选、详情归属、原位恢复和角色到期。Auth 测试验证中心角色、过期时间、UserInfo subject 与旧会话资料要求。

## 生产顺序

1. 唯一文件名备份当前生产 D1 并确认成功，查询迁移状态，只应用缺失迁移。已完成 `0007` 的库只需 additive `0008`；不重放历史点评、不批量改旧名或归属。
2. 先发布提供 canonical username、picture、roles 与 roles_checked_at 的 Auth，确认 profile 范围正确和用户名唯一不可变。保留 LXK 的 OIDC、Turnstile 变量与密钥，不新增本地管理员名单。
3. 发布已审核构建，仅少量检查公开页、管理拒绝路径与登录跳转；真实管理员重新验证中心角色。完整写入和封禁流程只在本地隔离数据验证。

```powershell
pixi run pnpm exec wrangler d1 migrations list DB --remote
pixi run pnpm exec wrangler d1 export DB --remote --output .wrangler/shou-courses-before-0008-<unique-time>.sql
pixi run pnpm exec wrangler d1 migrations apply DB --remote
pixi run build
pixi run pnpm exec wrangler deploy --config wrangler.jsonc --keep-vars --strict --var MAINTENANCE_MODE:false
```

0008 保留旧字段与数据，但回退旧管理应用会恢复旧版本的本地邮箱授权逻辑，应由维护者明确处理。不要为回退删除档案、审计、角色或封禁记录。LXK 封禁不修改认证中心账号状态。
