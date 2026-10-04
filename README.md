<div align="center">

# 🎓 SHOU LXK · 海大课程评价

**下一堂课，多一份参考。**

听听同学的课堂体验，找到适合自己的课程与老师。

[![立即访问](https://img.shields.io/badge/立即访问-LXK.SHOUMC.COM-319ddd?style=for-the-badge)](https://lxk.shoumc.com)
[![GitHub Stars](https://img.shields.io/github/stars/Conduit-Club/SHOU-LXK?style=for-the-badge&color=e9b44c)](https://github.com/Conduit-Club/SHOU-LXK)

![Svelte 5](https://img.shields.io/badge/Svelte_5-FF3E00?style=flat-square&logo=svelte&logoColor=white)
![SvelteKit 3](https://img.shields.io/badge/SvelteKit_3-FF3E00?style=flat-square&logo=svelte&logoColor=white)
![TypeScript 6](https://img.shields.io/badge/TypeScript_6-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Tailwind CSS 4](https://img.shields.io/badge/Tailwind_CSS_4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)
![Cloudflare Workers · D1](https://img.shields.io/badge/Cloudflare-Workers_·_D1-F38020?style=flat-square&logo=cloudflare&logoColor=white)

[读点评](https://lxk.shoumc.com/reviews) · [找课程](https://lxk.shoumc.com/courses) · [找老师](https://lxk.shoumc.com/teachers) · [反馈问题](https://github.com/Conduit-Club/SHOU-LXK/issues)

</div>

![新版首页：最新点评、站点概览与快速入口](docs/images/homepage.png)

> 截图来自本分支的本地生产构建，使用现有课程数据；生产效果以上线版本为准。README 的居中介绍、技术徽章及页面预览形式参考「今日海大吃什么」，网站右侧采用站点概览与快速入口布局。

## 在这里可以做什么

- **首页**：最新点评、最新收录老师、最新收录课程，各展示 5 条；每组及页底都有完整目录入口。目录无历史创建时间，因此“最新”按现有收录顺序展示，不代表最近开课或入职。
- **点评**：浏览课程和教师点评，独立搜索标题与正文，支持分页。
- **课程**：搜索名称或课程号，按学院、类型、授课教师、学分、属性和点评数量筛选。详情页先看课程信息和同学点评，点击“写点评”再展开表单；右侧展示教师、其他班级及同学院同学分的相似课程。
- **老师**：独立搜索姓名，进入教师页查看授课信息与点评。
- **补充目录**：课程、老师列表可提交尚未收录的课程号或教师，管理员核实后进入公开目录；自己的提交页可看进度与审核理由。已有目录点评仍提交即公开。详见 [补充审核](docs/CATALOG_SUBMISSIONS.md)。
- **顶部搜索**：仅搜索课程或课程号；点评与老师使用各自页面的搜索框。
- **统一账号**：注册与登录使用 [SHOU-Auth](https://auth.shoumc.com)，唯一用户名与头像在账号中心设置；本站会话有效 8 小时，可独立退出。
- **内容管理**：认证中心管理员可开启顶部“管理模式”，在点评搜索列表、课程和老师详情中原位删除/恢复点评、封禁/解封作者；完整管理面板支持内容、目标与作者筛选及审计分页。权限每次验证最多有效 1 小时，本站封禁保留旧点评并即时撤销本站会话。
- **分享体验**：登录并设置用户名后可提交点评，默认显示“匿名用户”并隐藏头像，也可选择已验证的账号用户名与头像；署名从服务端账号资料取得。写入要求会话、CSRF 和 Cloudflare Turnstile；历史点评保留原文与存储归属。
- **显示主题**：保留原深色主题，增加奶油、粉玫瑰与可可色浅色主题；顶部切换后记住偏好，刷新时在首屏绘制前应用。
- **加载失败**：显示统一、无内部细节的提示，并可玩本地校园跑酷——戴眼镜的学生躲避教学楼、收集 GPA POINTS。空格、↑ 或轻点画面跳跃；积分与真实成绩无关。

<details>
<summary>看看加载失败页与小游戏</summary>

![加载失败页与校园跑酷](docs/images/loading-failed.png)

</details>

<details>
<summary>看看课程详情页</summary>

![课程信息、同学点评与相似课程](docs/images/course-detail.png)

仅展示数据库已有信息；相似课程从最多 48 个同学院、同学分班级中去重选取最多 5 门，不代表全站热度排名。

</details>

## 技术栈

| 层次         | 实际使用                                                                 |
| ------------ | ------------------------------------------------------------------------ |
| 页面与服务端 | Svelte 5、SvelteKit 3、TypeScript 6，SSR 与渐进增强表单                  |
| 样式与组件   | Tailwind CSS 4、shadcn-svelte、Bits UI、Lucide Svelte                    |
| 构建与部署   | Vite 8、SvelteKit Cloudflare adapter 8、Wrangler 4、Cloudflare Workers   |
| 数据与缓存   | Cloudflare D1 / SQLite、SQL 索引与计数触发器、Workers Cache API          |
| 认证与点评   | SHOU-Auth OIDC / openid-client、D1 本站会话、CSRF、Cloudflare Turnstile  |
| 小游戏       | 原生 Canvas 2D 与 TypeScript，无远程游戏服务或额外图片依赖               |
| 本地开发     | 原生 Windows / PowerShell 7，Pixi 管理 Node.js 26、pnpm 12               |
| 检查与测试   | svelte-check、Oxlint、Oxfmt、Node test runner、Miniflare/workerd 本地 D1 |

准确依赖版本见 [package.json](package.json)、[pnpm-lock.yaml](pnpm-lock.yaml) 与 [pixi.lock](pixi.lock)。本项目没有 React、Astro 或 R2 依赖，也没有关注或星级评分功能。账号接入、环境变量与会话边界见 [UNIFIED_AUTH.md](docs/UNIFIED_AUTH.md)。

## 一次访问会读取多少行

以下是现有本地数据（1,909 门课程、3,286 个课段、5,597 条点评、970 位教师）在 Miniflare/workerd 的**整页服务端加载**实测。包括 COUNT、列表、授课教师及公共数据查询，而非只计算缓存部分。

| 页面第一页 | 缓存全冷：查询数 / 读取行 | 缓存命中：查询数 / 读取行 |
| ---------- | ------------------------: | ------------------------: |
| 首页       |                **4 / 32** |                 **0 / 0** |
| 课程目录   |                 7 / 2,802 |                    3 / 87 |
| 点评列表   |                    2 / 50 |                    2 / 50 |
| 老师列表   |                    2 / 13 |                    2 / 13 |

首页 32 行 = 最新点评 21 + 统计 1 + 课程 5 + 老师 5。原先无筛选 COUNT 的约 6,572 行扫描已替换为事务维护的单行统计读取，首页不再加载课程目录和筛选选项。

这些数字仍适用于游客，没有会话 Cookie 的请求不增加认证查询。已登录访问会额外执行一次通过索引关联的本站会话查询，同一请求只验证一次；个人账号与 CSRF 数据不进入公共缓存。

缓存属于服务器的数据中心，并不属于某个用户：新用户也可能命中已有缓存，老用户也可能遇到过期或不同地区的冷缓存。首页数据缓存 60 秒；课程筛选项缓存 6 小时。评论提交成功后清除当前数据中心的最新评论与展示统计，其他中心最多滞后一个 TTL。目录列表与精确分页总数不缓存。

课程、点评和姓名子串搜索仍有扫描成本。例如点评搜索“老师”本地为 5,655 行，不能将首页 32 行套用到搜索或深分页。关闭了悬停时的数据预加载，仅预加载代码，避免鼠标经过链接就触发查询。静态资源及小游戏不查询 D1。

完整前后 SQL、执行计划、搜索成本和一致性取舍见 [D1_READ_BUDGET.md](docs/D1_READ_BUDGET.md) 与 [整页测量记录](docs/read-budget-pages.json)。这不是生产账单保证。

## 本地运行

```powershell
pixi install
pixi run install
```

Pixi 从 conda-forge 创建锁定环境，pnpm 根据 lockfile 安装依赖。使用本地 D1；完整 schema 与历史数据说明见 [SCHEMA.md](SCHEMA.md)。

现有工作区已导入数据并应用 `0005`。新检出需取得 `shou-lxk-full-2026-10-02.sql.zip`，导入到空本地数据库后再应用剩余迁移：

```powershell
New-Item -ItemType Directory -Force .wrangler\shou-lxk-import-2026-10-02 | Out-Null
bz x shou-lxk-full-2026-10-02.sql.zip -o:.wrangler/shou-lxk-import-2026-10-02 -y
# 若 bz 不可用，可使用 Expand-Archive。
pixi run pnpm exec wrangler d1 execute DB --local --file .wrangler/shou-lxk-import-2026-10-02/shou-lxk-full-2026-10-02.sql
pixi run pnpm exec wrangler d1 migrations apply DB --local
pixi run dev
```

该归档已包含 `0001` 至 `0004` 的迁移记录，不要重复执行它们。没有归档时，可在空库执行 `schema.sql` 建立空白演示库；不要再对其重放结构迁移。

本地提交测试可把 `.dev.vars.example` 复制为 `.dev.vars`，使用 Cloudflare 官方测试键；不要在生产使用测试键。生产的 `TURNSTILE_SITE_KEY` 是公开变量，`TURNSTILE_SECRET_KEY` 必须作为 Worker secret 保存。缺少配置或验证服务不可用时，提交验证失败关闭。

统一登录还需独立本地 OIDC client 与 secret，Auth 默认联调端口为 8788、LXK 为 5173。生产 callback 固定为 `https://lxk.shoumc.com/auth/callback`，HTTP 只在显式配置的 loopback 开发环境可用。缺少认证配置时仍可浏览，无法开始新登录；新点评始终要求有效本站会话，详见 [统一认证](docs/UNIFIED_AUTH.md)。

## 检查与复现

```powershell
pixi run check
pixi run lint
pixi run test
pixi run build
pixi run pnpm benchmark:d1 --database <本地SQLite文件路径>
pixi run pnpm benchmark:pages --database <本地SQLite文件路径>
```

可用 `rg --files --hidden --no-ignore .wrangler/state -g '*.sqlite'` 查找本地数据库。基准脚本以只读事务复制本地数据到临时 Miniflare D1，绝不连接远程数据库。报告输出到 `.wrangler/read-budget/`。测试覆盖排序、筛选、分页、计数事务、真实 Cache API、Turnstile 拒绝路径、错误脱敏及跑酷规则。

## 部署

仓库不使用 Git 自动部署。读取优化需要 `0005`，统一账号需要 `0006`，本站管理需要 `0007`，中心资料、角色与发表身份需要 `0008`，目录补充审核需要 `0009`。备份、迁移成本和回退说明见 [读取优化上线步骤](docs/D1_READ_BUDGET.md#上线步骤)、[统一认证](docs/UNIFIED_AUTH.md#上线顺序与回退) 与 [管理员上线顺序](docs/ADMIN_MODERATION.md#生产顺序)。远程变更须由维护者明确决定。

```powershell
pixi run pnpm exec wrangler d1 export DB --remote --output .wrangler/shou-courses-before-next-migration-<unique-time>.sql
pixi run pnpm exec wrangler d1 migrations apply DB --remote
pixi run build
pixi run pnpm exec wrangler deploy --config wrangler.jsonc --keep-vars --strict --var MAINTENANCE_MODE:false
```

配置见 `wrangler.jsonc`。保留生产 Turnstile 变量和密钥，并提前以 Worker Secret 保存 `OIDC_CLIENT_SECRET`。若启用 Workers Builds，`.node-version` 指定 Node.js 26，并在构建变量中设置 `PNPM_VERSION=12`。

### 临时维护

`MAINTENANCE_MODE=true` 时，服务端在加载数据与执行表单前返回不缓存的 503 维护页，暂停本网站的 D1 访问，不删除数据库或绑定。维护版可在迁移之前发布，但必须保持此开关开启。正常发布前应先成功备份、完成所需迁移，再显式传入 `--var MAINTENANCE_MODE:false`；`--keep-vars` 单独使用会保留维护状态。
