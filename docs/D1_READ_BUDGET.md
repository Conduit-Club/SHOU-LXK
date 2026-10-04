# 首页 D1 读取优化（2026-10-03）

所有基准与故障模拟只使用本地数据库。用户提供的查询分析用于定位热点，不将不同统计范围的数字相加作为每日用量。以下先记录新版独立首页的整页预算，再保留第一轮 SQL 优化的前后对照。

## 新版页面：首次与重复访问

`benchmark:pages` 调用实际四个页面的完整服务端 loader，将每条 SQL 的 D1 `meta.rows_read` 求和。没有只统计缓存函数；布局没有额外数据库读取。每个页面先清空独立缓存测冷访问，再保留同一缓存测热访问。源 SQLite 只读，查询在临时 Miniflare/workerd 中执行。

| 页面 / 查询        | 冷缓存查询数 | 冷缓存读取 | 热缓存查询数 | 热缓存读取 |
| ------------------ | -----------: | ---------: | -----------: | ---------: |
| 首页               |            4 |     **32** |            0 |      **0** |
| 课程目录第一页     |            7 |      2,802 |            3 |         87 |
| 点评目录第一页     |            2 |         50 |            2 |         50 |
| 老师目录第一页     |            2 |         13 |            2 |         13 |
| 课程搜索：人工智能 |            7 |      6,855 |            3 |      4,140 |
| 点评搜索：老师     |            2 |      5,655 |            2 |      5,655 |
| 老师搜索：关欣     |            2 |      1,940 |            2 |      1,940 |

首页 32 行拆分：最新评论 21、单行统计 1、课程 5、老师 5。**原约 6,572 行的无筛选 COUNT 已不存在于新版首页路径**；课程目录的无筛选总数也只读 1 行。首页不读取筛选项、完整列表、授课教师或分页 COUNT。首页三组内容各最多 5 条，所有数据均为公开信息，缓存 60 秒。

缓存按数据中心和主机共享，不是“某位用户已经访问过”的个人缓存。第一次来的用户也可命中；过期、淘汰、不同地区或主机均可能冷读。不承诺生产固定计费或全球共享。统一认证之后游客布局仍不查询 D1；只有有效会话 Cookie 的访问增加一次索引会话/用户关联查询，同一请求不重复查询。账号和 CSRF 数据只进入禁止共享缓存的页面响应，不进入首页公共 JSON Cache。HTML 的悬停数据预加载仍为仅预加载代码；静态文件和小游戏不查询 D1。完整认证边界见 [UNIFIED_AUTH.md](UNIFIED_AUTH.md)。

目录保留实时列表及精确 COUNT；子串搜索与深 OFFSET 仍可能扫描更多数据。点评目录对参数化 LIMIT 使用候选在前的 CROSS JOIN，防止查询计划先扫描全部课程和老师；本地未修正时单条列表读 11,395 行，修正后 49 行，另加 COUNT 1 行。最新评论仍保持日期降序、类型升序、ID 降序。

课程与老师缺少历史创建时间，“最新”按课程 rowid / 教师 ID 倒序展示，页面明确标注按收录顺序，不将其解释为实际开课或入职时间。导入/重建顺序变化可能改变这一顺序；若以后需要审计级新增时间，应另建明确时间字段。

完整测量记录（每条 SQL 与读取量）见 [read-budget-pages.json](read-budget-pages.json)。运行方式：

```powershell
pixi run pnpm benchmark:pages --database <本地SQLite文件路径>
```

真实 Workers Cache API 测试另验证了不同 Cookie 的请求共享首页缓存且热请求 0 次 SQL。原有 SQL、目录搜索、分页和跑酷测试共 11 项。实际本地生产构建在一个独立空数据库上触发 HTTP 500，检查 SSR HTML 和 SvelteKit 数据响应均不含 `D1_ERROR`、SQL、表名或数据库标识；错误页仅显示统一失败说明及本地跑酷游戏。未连接生产做故障注入。

## 查询与正确性

- 最新评论先分别按日期倒序、ID 倒序取课程和教师评论各 5 条，再关联展示信息、`UNION ALL`，按 `posted_at_local DESC, review_type ASC, id DESC` 取最终 5 条。相同日期仍先课程后教师，再按 ID 倒序。依赖现有外键完整性；本地数据无外键异常。
- `site_stats` 单行保存课程、课段、两类评论合计及教师总数。迁移一次性回填，10 个插入/删除触发器在原事务内维护；普通更新和评论移动不改变全站总数。原有课段评论数触发器继续维护 `review_count`。
- 未筛选的列表总数实时读取 `site_stats.sections`；有筛选时执行实时精确 `COUNT`，不使用缓存的展示统计推算页数。不需要课程名称时去除 COUNT 的课程关联。
- 单独课程子串搜索先查课程 ID，再匹配课段；组合筛选保留课程关联，让选择性较高的课段条件先缩小范围。教师搜索用去重的成员判断，避免多个匹配教师造成重复课段。保留大小写、子串、字面 `%`/`_`、属性 trim 和所有分页排序语义。
- 增加课程名称、课段课程 ID、类型、学分、属性表达式、学院与学分组合索引。索引维护增加写入成本，评论触发器也增加一次统计行更新；这是用少量写入换取高频读取节省。

## 缓存与一致性

使用 Workers Cache API 的命名缓存 `shou-lxk-home-v1`，仅缓存三个公共 JSON 数据组。键包含主机名，丢弃请求路径、查询参数和所有请求头；搜索、筛选、翻页共享缓存。

| 数据                       | TTL    | 更新策略                                                                                  |
| -------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| 学院、类型、属性、学分选项 | 6 小时 | 评论不改变选项；目录维护后允许至多 6 小时旧选项，要求立即更新时随部署提升缓存名称和键版本 |
| 最新评论                   | 60 秒  | 成功提交评论后，重定向前等待本数据中心删除                                                |
| 展示用全站统计             | 60 秒  | 同上                                                                                      |

Cache API 只在当前数据中心生效，删除并非全球清除；其他中心、其他主机名及与删除竞态的在途回填，可能显示最多一个 TTL 的旧数据。TTL 从数据库查询开始计算，慢回填不能重新获得完整 TTL。没有声称全局即时一致，也没有使用无期限的进程缓存。参见 [Cloudflare Cache API 文档](https://developers.cloudflare.com/workers/runtime-apis/cache/)。

列表、精确 COUNT、课段教师、详情及提交响应不缓存。数据库中的计数是事务内维护的；页面 COUNT 和列表仍为独立查询，不提供并发目录增删期间跨查询的快照保证。成功写入后下一次详情读取可见评论，首页公共区域受上述 TTL 约束。

不缓存 Cookie、Turnstile token、用户请求内容或 HTML。服务端 Siteverify、hostname/action 校验仍在写入前执行；验证失败不写库、不清缓存。缓存不可用时回源，数据库错误不写入缓存；缓存写入/删除失败不把已成功的评论提交变成失败。本次还将课程评论的成功重定向改为同源相对路径，修复 SvelteKit 3 拒绝绝对地址重定向的问题。

## 本地实测

通过只读 SQLite 快照复制现有数据到临时 Miniflare/workerd D1，先执行旧查询，再应用 `0005` 并执行新查询。共比较 **106 条 SQL** 的完整返回值及顺序，全部相同。源数据：1,909 门课程、3,286 个课段、970 位教师、4,406 条授课关系、5,597 条课程评论、0 条教师评论、97 条类别选项。两类评论混合和并列顺序另用测试数据验证。

以下均为本地 D1 返回的 `meta.rows_read`，不是 EXPLAIN 估计，也不是生产计费保证：

| 查询                            | 修改前 | 修改后 |
| ------------------------------- | -----: | -----: |
| 最新 5 条评论                   | 22,389 |     21 |
| 全站统计                        | 11,762 |      1 |
| 学院 / 类型选项                 | 14 / 5 | 14 / 5 |
| DISTINCT 学分                   |  6,572 |     15 |
| DISTINCT trim(属性)             |  3,958 |  2,681 |
| 无筛选 COUNT                    |  6,572 |      1 |
| 课程搜索 COUNT（人工智能）      |  6,572 |  2,005 |
| 教师搜索 COUNT（关欣）          | 15,383 |    986 |
| 学院 COUNT（信息学院）          |    727 |    364 |
| 类型 COUNT（必修）              |  5,270 |  1,985 |
| 学分 COUNT（2）                 |  4,548 |  1,263 |
| 属性 COUNT（所选真实值见 JSON） |  3,288 |      3 |
| 最少 10 条评论 COUNT            |    291 |    146 |
| 组合条件 COUNT                  |    514 |    245 |
| 不存在的课程搜索 COUNT          |  6,572 |  1,910 |
| 默认名称排序第一页列表          |  9,858 |     44 |
| 默认评论数排序第一页列表        |     38 |     38 |

公共数据 6 条查询合计从每次 **44,700** 行降至冷缓存 **2,737** 行（约减少 93.9%）。连续 10 次不同查询参数的公共数据缓存命中，合计 **0 次 D1 查询、0 行读取**。这是公共部分；整页仍执行 COUNT、分页列表及教师查询，不能称整页零读取。

两条单独列表查询出现退步，保留在完整报告中：课程搜索按评论数排序第一页 `1,151 → 2,081`，但其 COUNT + 列表总计 `7,723 → 4,086`；最少 10 条评论、按学分排序、offset 120 的列表 `436 → 461`，连同 COUNT 为 `727 → 607`。子串搜索仍需要扫描课程或教师，深 OFFSET 仍有成本；本次没有改变搜索语义或改为游标分页。

### EXPLAIN QUERY PLAN 摘要

| 查询                | 修改前关键计划                                         | 修改后关键计划                                                                            |
| ------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| 最新评论            | 评论 `SCAN r` 后逐行关联，最终临时排序                 | `course_latest` / `teacher_latest` 协程沿两个 latest 索引各 LIMIT 5；仅候选关联并最终排序 |
| 统计 / 无筛选 COUNT | 多表扫描 / 课段扫描加课程逐行查找                      | `SEARCH site_stats USING INTEGER PRIMARY KEY (rowid=?)`                                   |
| 学分                | `SCAN course_section` + `USE TEMP B-TREE FOR DISTINCT` | `SCAN course_section USING COVERING INDEX course_section_credits_idx`                     |
| 属性                | 扫描表 + 临时 DISTINCT                                 | `SCAN course_section USING INDEX course_section_attribute_idx`                            |
| 教师 COUNT          | 逐课段的 `CORRELATED SCALAR SUBQUERY`                  | `LIST SUBQUERY` 扫描教师，再沿 teacher 索引查关系和课段主键                               |
| 名称排序列表        | 扫描课段并对全部结果排序                               | 沿 `courses_name_idx` 读取课程、用 `course_section_course_id_idx` 查课段，部分排序        |

`SCAN ... USING INDEX` 本身不等于只读几行。学分结果受本地数据分布与 `PRAGMA optimize` 统计信息影响；属性冷查询仍读 2,681 行，必须配合缓存。完整 106 条前后计划、绑定参数与 rows_read 在 `.wrangler/read-budget/benchmark.json`；文件无评论正文，仍作为本地产物忽略。D1 对读取行数和索引写入的解释见 [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)，统计信息维护见 [SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/)。

## 复现

```powershell
pixi run test
pixi run check
pixi run lint
pixi run build
pixi run pnpm benchmark:d1 --database .wrangler/state/v3/d1/miniflare-D1DatabaseObject/eeeaefda7d66d830422b773f42701884f5c31d8774f365ae96afe656a07224c7.sqlite
```

数据库路径因环境而异，可用 `rg --files --hidden --no-ignore .wrangler/state -g '*.sqlite'` 查找。脚本只接受本地路径，以只读事务读取源数据，在独立临时 D1 重建前后环境，不调用远程 Wrangler。即使源数据库已应用 `0005`，仍可重新比较。测试中的 Miniflare 关闭云配置和遥测。

测试覆盖：最新评论双表交错/并列/空表、计数插入/删除/移动/回滚、48 组筛选排序与四个偏移的旧新一致性、页码规范化/越界/空结果、缓存跨参数命中/主机隔离/TTL/异常/失效竞态、课程和教师提交成功清缓存、Turnstile hostname/action 失败禁止写入。另一个独立 workerd 测试验证真实 Cache API 跨请求命中及写入后失效。Siteverify 网络返回在本地测试中模拟；未进行生产 Turnstile、生产缓存跨地区或实际计费验证。

本次最终验证：`pixi run test` 12/12 通过，`pixi run check` 0 错误 / 0 警告，`pixi run lint`、`pixi run build` 和 `git diff --check` 均通过。本地实际数据库迁移记录为 `0001` 至 `0005`，`site_stats` 与上述数据量一致，`PRAGMA foreign_key_check` 返回空结果。测试有 Node 实验性 TypeScript stripping 提示，构建有终端颜色环境变量提示，均未导致失败。

## 课程详情补充

详情页使用事务维护的班级点评计数，避免重复 COUNT；相似课程沿学院/学分索引最多读取 48 个候选班级，再去重并排除当前课程，最多展示 5 门。仅为有限候选推荐，不保证全站热度排名。

现有本地数据下，课程 `7109911` 的 `lid=850` 首页完整 loader 为 5 次查询 / 297 行读取，其中推荐查询读取 76 行；全部班级视图为 5 次 / 419 行。点评排序仍有随该课程点评量增长的成本。新增本地 D1 测试覆盖班级计数、删除后的计数一致性、推荐去重、无数据和错误班级、分页与写点评入口。

## 计数维护

正常 INSERT、DELETE、UPDATE 路径无需重算。不要绕过触发器，或假设 `INSERT OR REPLACE` 的隐式删除一定触发统计维护；批量导入应使用普通 INSERT / `ON CONFLICT DO UPDATE`，并在导入后核对真实计数。若使用禁用触发器的导入或 REPLACE，需要在维护期间重建统计：

```sql
UPDATE site_stats SET
  courses = (SELECT COUNT(*) FROM courses),
  sections = (SELECT COUNT(*) FROM course_section),
  reviews = (SELECT COUNT(*) FROM course_reviews) + (SELECT COUNT(*) FROM teacher_reviews),
  teachers = (SELECT COUNT(*) FROM teachers)
WHERE id = 1;
PRAGMA optimize;
```

这会扫描数据，仅用于维护；同时核对原有 `course_section.review_count`，并处理公共缓存版本或等待 TTL。

## 上线步骤

本地已备份后应用 `0005`。2026-10-03 远程迁移列表查询返回 D1 `7500`（免费读取额度耗尽），网站暂时维护；2026-10-04 配额恢复后已完成生产备份、`0005` 迁移、统计核对和新版部署，首页、目录与详情返回 HTTP 200。以下保留这一迁移的上线顺序供复核；后续统一认证另见 [UNIFIED_AUTH.md](UNIFIED_AUTH.md)，仅应用尚缺失的迁移。

1. 确认生产 D1 配额恢复并预留迁移预算。建索引、一次性 COUNT 回填及统计分析会消耗读取/写入；不要在免费额度已耗尽时反复重试。免费额度按 UTC 日重置，见上述 D1 pricing 文档。
2. 导出生产备份并确认导出成功，然后先迁移、后部署。以下远程变更命令尚未执行：

```powershell
pixi run pnpm exec wrangler d1 export DB --remote --output .wrangler/shou-courses-before-0005.sql
pixi run pnpm exec wrangler d1 migrations apply DB --remote
pixi run pnpm exec wrangler d1 execute DB --remote --command "SELECT * FROM site_stats;"
pixi run check
pixi run lint
pixi run test
pixi run build
pixi run pnpm exec wrangler deploy --config wrangler.jsonc --keep-vars --strict --var MAINTENANCE_MODE:false
```

3. 少量访问首页、筛选和详情确认成功，观察实际 rows_read 与错误率；无需压测。新部署不能先于 `0005`，否则缺少 `site_stats` 会报错。保持生产 Turnstile 密钥及变量。
4. 若应用回退，`0005` 与旧应用 SQL 兼容，可保留新增表、索引和触发器；避免为回退应用而删除数据库对象。旧应用仍有原读取放大，故优先修正前进。
