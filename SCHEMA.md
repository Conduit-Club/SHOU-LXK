# SHOU LXK database schema

[`schema.sql`](schema.sql) defines the current SQLite and Cloudflare D1 schema. All tables are `STRICT`. Course IDs and section `lid` values are `TEXT` to preserve source codes and leading zeroes. `credits`, `likes`, and `dislikes` are `INTEGER`; the two counters default to zero and must be nonnegative.

| Table                     | Grain                                       | Rows in the 2026-10-02 archive |
| ------------------------- | ------------------------------------------- | -----------------------------: |
| `courses`                 | One course code                             |                          1,909 |
| `course_section`          | One API section `lid`                       |                          3,286 |
| `teachers`                | One distinct normalized teacher name        |                            970 |
| `course_section_teachers` | One teacher assigned to a section           |                          4,406 |
| `course_reviews`          | One course review with a stable integer ID  |                          5,597 |
| `teacher_reviews`         | One teacher review with a stable integer ID |                              0 |
| `category_options`        | One selectable category value               |                             97 |

The 2026-10-02 archive is `shou-lxk-full-2026-10-02.sql.zip`; the extracted SQL is kept under the ignored `.wrangler/shou-lxk-import-2026-10-02/` directory. The dump contains the schema through `0004` and records `0001` through `0004` in `d1_migrations`, so import it directly into a new empty D1 and do not apply the four migrations again. Apply pending migration `0005` after importing:

```sh
pixi run pnpm exec wrangler d1 execute shou-courses --local --file .wrangler/shou-lxk-import-2026-10-02/shou-lxk-full-2026-10-02.sql
pixi run pnpm exec wrangler d1 migrations apply DB --local
```

The audited dump passes SQLite `integrity_check`, has zero foreign-key violations, and has 669 sections with multiple teachers. Its `course_section.review_count` sum is 5,597 and matches `course_reviews`. Review text is free-form user content; the historical archive has no separate reviewer identity, email, phone, URL, ID-card, or bank-card columns. Treat review content as potentially identifying text when exposing or exporting it.

A section belongs to one course. Course reviews refer directly to sections through `lid`; `id` is an automatically assigned integer primary key. Reviews default to newest first by `posted_at_local`, with `id` breaking timestamp ties; readers can switch to oldest first. `posted_at_local` stores the source's UTC+8 wall-clock text. Teachers live in `teachers` with integer IDs and unique names. `course_section_teachers` links sections to one or more teachers, preserving their display order with `position`. `teacher_reviews` references `teachers.id`; these reviews never contribute to course-section review counts. The old `teacher_name` and `teacher_list_raw` columns are removed. Empty and missing attributes remain distinct (`''` and `NULL`).

The home page lists `course_section` rows and joins `courses` for course names. `course_section.review_count` stores review totals for ranking, filtering, and display; triggers keep it in sync with review inserts, deletes, and section moves. The old `hot_entries`, `review_fetches`, `comments_count`, and `hits` data is removed. Historical likes and dislikes are reset to zero during migration.

Teacher identity is based on the exact normalized name because the source has no reliable teacher ID. Suffixes such as `(1804)` are preserved; identical names share a profile. The migration splits whitespace, commas, Chinese commas, enumeration commas, and semicolons, and deduplicates repeated names within a section. The `teacher_list_raw` values contain course-wide `name|section-id` options, so they must not be interpreted as co-teachers or teacher IDs.

## Migration

[`migrations/0001_section_schema.sql`](migrations/0001_section_schema.sql) converts a database with the original `shou-coursecritic` schema. It copies sections and reviews into the new strict tables, recreates the review foreign key, then removes the old tables. Apply migrations in order against an existing database. [`0002_review_ids.sql`](migrations/0002_review_ids.sql) preserves all review content while replacing `position` with `id` and adding a section lookup index. [`0003_section_review_count.sql`](migrations/0003_section_review_count.sql) backfills stored review counts and installs maintenance triggers. Apply it before deploying the listing code that reads `review_count`. [`0004_teachers_and_reviews.sql`](migrations/0004_teachers_and_reviews.sql) creates and backfills teachers and section membership, renames `reviews` to `course_reviews` without changing IDs or content, recreates its counter triggers, and adds `teacher_reviews`. Apply it before running the updated application. For a new empty database, use `schema.sql` and import data in the new column layout.

The original archive importer and SQL snapshot are in the sibling `StructureAnalysis-shou-laixk` repository. That snapshot still uses the old schema. To use it locally, import the snapshot first and then apply the migration:

```sh
pixi run pnpm exec wrangler d1 execute DB --local --file ../StructureAnalysis-shou-laixk/data/shou-coursecritic.sql
pixi run pnpm exec wrangler d1 migrations apply DB --local
```

The new Cloudflare database is `shou-courses` in APAC, with binding `DB`, ID `9e6f10ee-4e0b-4b8c-8662-b598ba79f3ba`, and account ID `15ce34fcf3c0f4fc58e57f5d7cc10c21` in `wrangler.jsonc`. It was created empty for the 2026-10-02 archive and imported directly from the dump on 2026-10-03. Remote verification reports 1,909 courses, 3,286 sections, 970 teachers, 4,406 section-teacher links, 5,597 course reviews, 0 teacher reviews, 97 category options, and 4 migration records; the stored review-count sum is 5,597 and the foreign-key violation count is zero. The application was deployed manually with Wrangler on 2026-10-03 and is live at `https://lxk.shoumc.com`. The previously configured `shou-lxk` database ID `8fd0140d-9e3e-435a-a42d-2e39574a7f84` is not modified by this import; its accessibility in the target account has not been re-verified.

Migration [`0005_home_read_budget.sql`](migrations/0005_home_read_budget.sql) adds bounded latest-review indexes, catalog/filter indexes, and the singleton `site_stats` table. Its insert/delete triggers maintain exact totals in the same transaction; existing section review-count triggers remain in place. It finishes with `PRAGMA optimize`. This migration is applied locally and was applied to production on 2026-10-04 before the optimized application reopened. Fresh databases created with `schema.sql` already contain these objects; do not replay structural migrations on them, and run `PRAGMA optimize` after loading data. See [D1_READ_BUDGET.md](docs/D1_READ_BUDGET.md) for counter maintenance, cache behavior, measurements, and rollout.

## Unified identity and sessions

Migration [`0006_unified_auth.sql`](migrations/0006_unified_auth.sql) adds `auth_users`, `auth_sessions`, `auth_login_transactions`, and nullable `author_id` foreign keys to both review tables. It is additive and preserves all historical IDs, text, counts and review ordering; legacy authors remain NULL. Fresh `schema.sql` includes these tables and columns. Apply only missing migrations to an existing database.

`auth_users` is keyed by the exact OIDC issuer and stable subject, with a bounded display name and login timestamps. It does not persist email or upstream access/refresh tokens. `auth_sessions` stores only a SHA-256 token hash, local user ID, CSRF token, creation time and absolute expiry. `auth_login_transactions` stores hashed state/browser binding, short-lived PKCE verifier/nonce and a validated local return path; an atomic delete consumes a transaction exactly once. Session and transaction expiry indexes bound cleanup on login.

New reviews bind `author_id` to the server-validated session user. This association is never included in public review queries or shared public caches; deleting a local identity sets review authors to NULL and preserves their content. Authentication data in D1 exports is private even though course catalog and displayed reviews are public. See [UNIFIED_AUTH.md](docs/UNIFIED_AUTH.md) for cookie settings, eight-hour TTL, CSRF, account-center logout/disable limitations, environment configuration, local testing and rollout.

The previously migrated local snapshot contained 971 teachers, 4,407 section-teacher links, and 5,631 course reviews. Those counts describe that older archive; the 2026-10-02 dump has the audited counts above.

Deploy the migration and application together during a maintenance window: the old application queries `reviews` and `teacher_name`, while the new application requires the new tables. Back up the remote database before applying migrations. This change and the production D1 import and application deployment are complete; future schema migrations remain separate steps.
