import "./helpers/server-imports.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { executeScript, localD1, measureDatabase, MemoryCache, migration } from "./helpers/local-d1.mjs";
import { legacyCatalog, legacyLatest, legacyStats } from "./helpers/legacy-queries.mjs";

const { LATEST_REVIEWS_SQL, SITE_STATS_SQL, catalogQueries, parseHomeFilters } =
  await import("../src/lib/server/home-queries.ts");
const { HOME_TTL, loadHomePublicData, readHomeCache, invalidateHomeReviews } =
  await import("../src/lib/server/home-cache.ts");
const home = await import("../src/routes/courses/+page.server.ts");
const courses = await import("../src/routes/courses/[courseId]/+page.server.ts");
const teachers = await import("../src/routes/teachers/[teacherId]/+page.server.ts");

async function fixture(run) {
  const local = await localD1();
  try {
    const db = local.db;
    await executeScript(db, await readFile(new URL("./fixtures/schema-before-0005.sql", import.meta.url), "utf8"));
    await executeScript(
      db,
      `
      INSERT INTO courses VALUES ('001', 'Alpha'), ('002', 'alpha'), ('003', '人工智能 100%_');
      INSERT INTO teachers VALUES (1, '同名教师甲'), (2, '同名教师乙'), (3, 'Alex');
      INSERT INTO category_options VALUES ('college', 1, '信息学院'), ('lessonType', 1, '必修');
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 35)
      INSERT INTO course_section(lid, course_id, college, elective_type, credits, attribute)
      SELECT CAST(x AS TEXT), CASE WHEN x % 3 = 0 THEN '003' WHEN x % 2 = 0 THEN '002' ELSE '001' END,
        CASE WHEN x % 2 = 0 THEN '信息学院' ELSE '学院二' END,
        CASE WHEN x % 2 = 0 THEN '必修' ELSE '选修' END, x % 4,
        CASE WHEN x % 4 = 0 THEN NULL WHEN x % 4 = 1 THEN '' WHEN x % 4 = 2 THEN ' 理论课 ' ELSE '实验课' END
      FROM n;
      INSERT INTO course_section_teachers SELECT lid, 1, 1 FROM course_section;
      INSERT INTO course_section_teachers SELECT lid, 2, 2 FROM course_section WHERE CAST(lid AS INTEGER) % 2 = 0;
      INSERT INTO course_section_teachers VALUES ('1', 3, 2);
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 90)
      INSERT INTO course_reviews(id, lid, title, content, posted_at_local)
      SELECT x, CAST(x % 35 + 1 AS TEXT), 'title', 'body', '2025-01-01 00:00:00' FROM n;
      INSERT INTO course_reviews VALUES (101, '1', 'tie 1', 'body', '2026-01-01 00:00:00'),
        (102, '1', 'tie 2', 'body', '2026-01-01 00:00:00');
      INSERT INTO teacher_reviews VALUES (101, 1, 'teacher tie 1', 'body', '2026-01-01 00:00:00'),
        (102, 1, 'teacher tie 2', 'body', '2026-01-01 00:00:00'),
        (103, 1, 'newer teacher', 'body', '2026-01-02 00:00:00');
    `,
    );
    await run(db);
  } finally {
    await local.close();
  }
}

test("top-five branch limits preserve timestamp/type/id ties and avoid full review scans", async () => {
  await fixture(async (db) => {
    const before = await db.prepare(legacyLatest).all();
    await executeScript(db, await migration());
    const after = await db.prepare(LATEST_REVIEWS_SQL).all();
    assert.deepEqual(after.results, before.results);
    assert.deepEqual(
      after.results.map((row) => [row.review_type, row.id]),
      [
        ["teacher", 103],
        ["course", 102],
        ["course", 101],
        ["teacher", 102],
        ["teacher", 101],
      ],
    );
    assert.ok(after.meta.rows_read < before.meta.rows_read, `${before.meta.rows_read} -> ${after.meta.rows_read}`);
    // All five may come from just one branch, and either branch may be empty.
    await executeScript(db, "DELETE FROM teacher_reviews");
    assert.deepEqual(
      (await db.prepare(LATEST_REVIEWS_SQL).all()).results,
      (await db.prepare(legacyLatest).all()).results,
    );
    await executeScript(db, "DELETE FROM course_reviews");
    assert.deepEqual((await db.prepare(LATEST_REVIEWS_SQL).all()).results, []);
  });
});

test("migration counters track inserts, deletes, moves, updates and rolled-back writes", async () => {
  await fixture(async (db) => {
    await executeScript(db, await migration());
    const checkCounts = async () => {
      assert.deepEqual(await db.prepare(SITE_STATS_SQL).first(), await db.prepare(legacyStats).first());
      const mismatches = await db
        .prepare(`SELECT cs.lid FROM course_section cs
        WHERE cs.review_count <> (SELECT COUNT(*) FROM course_reviews r WHERE r.lid = cs.lid)`)
        .all();
      assert.deepEqual(mismatches.results, []);
    };
    await checkCounts();
    for (const sql of [
      "INSERT INTO courses VALUES ('new', 'New course')",
      "INSERT INTO teachers VALUES (4, 'New teacher')",
      "INSERT INTO course_section(lid, course_id, college, elective_type, credits) VALUES ('new', 'new', 'c', 'e', 0)",
      "INSERT INTO course_reviews VALUES (1000, 'new', 'new', 'body', '2026-01-03')",
      "INSERT INTO teacher_reviews VALUES (1000, 4, 'new', 'body', '2026-01-03')",
      "UPDATE course_reviews SET lid = '1', title = 'moved' WHERE id = 1000",
      "UPDATE teacher_reviews SET teacher_id = 1, posted_at_local = '2026-01-04' WHERE id = 1000",
      "DELETE FROM course_reviews WHERE id = 1000",
      "DELETE FROM teacher_reviews WHERE id = 1000",
      "DELETE FROM course_section WHERE lid = 'new'",
      "DELETE FROM courses WHERE course_id = 'new'",
      "DELETE FROM teachers WHERE id = 4",
    ]) {
      await executeScript(db, sql);
      await checkCounts();
    }
    await assert.rejects(
      executeScript(
        db,
        "INSERT INTO course_reviews(lid,title,content,posted_at_local) VALUES ('missing','no','no','2026')",
      ),
    );
    await checkCounts();
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
    assert.equal((await db.prepare("SELECT sections AS total FROM site_stats WHERE id=1").all()).meta.rows_read, 1);
  });
});

test("filter counts, unique sections, all sort orders and pagination match the old queries", async () => {
  await fixture(async (db) => {
    await executeScript(db, await migration());
    const scenarios = [
      {},
      { q: "alpha" },
      { q: "001" },
      { q: "%_" },
      { q: "' OR 1=1 --" },
      { teacher: "同名" },
      { teacher: "alex" },
      { teacher: "none" },
      { college: "信息学院" },
      { electiveType: "选修" },
      { credits: "0" },
      { attribute: " 理论课 " },
      { minReviews: "3" },
      {
        q: "ALPHA",
        teacher: "同名",
        college: "信息学院",
        electiveType: "必修",
        credits: "2",
        attribute: "理论课",
        minReviews: "1",
      },
      { credits: "-1", minReviews: "0" },
      { credits: "9007199254740992", minReviews: "1.5" },
    ];
    for (const params of scenarios) {
      for (const sort of ["reviews", "name", "credits"]) {
        const filters = parseHomeFilters(new URLSearchParams({ ...params, sort }));
        const before = legacyCatalog(filters);
        const after = catalogQueries(filters);
        assert.deepEqual(
          await db
            .prepare(after.count)
            .bind(...after.values)
            .first(),
          await db
            .prepare(before.count)
            .bind(...before.values)
            .first(),
          JSON.stringify(params),
        );
        for (const offset of [0, 12, 24, 999]) {
          const old = await db
            .prepare(before.list)
            .bind(...before.values, 12, offset)
            .all();
          const current = await db
            .prepare(after.list)
            .bind(...after.values, 12, offset)
            .all();
          assert.deepEqual(current.results, old.results, `${JSON.stringify(params)} ${sort} ${offset}`);
          assert.equal(new Set(current.results.map((row) => row.lid)).size, current.results.length);
        }
      }
    }
  });
});

test("catalog pagination clamps invalid/huge pages and does not use stale cached totals", async () => {
  await fixture(async (db) => {
    await executeScript(db, await migration());
    const cache = new MemoryCache();
    const previousCaches = globalThis.caches;
    globalThis.caches = { open: async () => cache };
    try {
      const load = (query) =>
        home.load({ platform: { env: { DB: db } }, url: new URL(`http://localhost/courses${query}`) });
      await loadHomePublicData(db, new URL("http://localhost/"));
      for (const [query, expectedPage] of [
        ["", 1],
        ["?page=-1", 1],
        ["?page=1.5", 1],
        ["?page=9007199254740992", 1],
        ["?page=999", 3],
      ]) {
        const result = await load(query);
        assert.equal(result.page, expectedPage);
        assert.equal(result.total, 35);
        assert.equal(result.pages, 3);
      }
      const empty = await load("?q=missing&page=999");
      assert.equal(empty.page, 1);
      assert.equal(empty.pages, 1);
      assert.equal(empty.total, 0);
      assert.deepEqual(empty.sections, []);
      await executeScript(
        db,
        "INSERT INTO course_section(lid,course_id,college,elective_type,credits) VALUES ('36','001','c','e',1)",
      );
      const updated = await load("?page=999");
      assert.equal(updated.total, 36);
      assert.equal(updated.sections.length, 12);
      const staleHome = await loadHomePublicData(db, new URL("http://localhost/"));
      assert.equal(staleHome.stats.sections, 35); // Public stats may lag; paging cannot.
    } finally {
      globalThis.caches = previousCaches;
    }
  });
});

test("cache ignores query/page, separates hosts, expires by TTL and never caches failures", async () => {
  const cache = new MemoryCache();
  let now = 1000;
  let queries = 0;
  const load = async () => ++queries;
  const get = (url, key = "latest") => readHomeCache(cache, new URL(url), key, load, () => now);
  assert.equal(await get("http://localhost:5173/"), 1);
  assert.equal(await get("http://localhost:5173/?q=x&page=77"), 1);
  assert.equal(await get("https://localhost:5173/teachers/1?submitted=1"), 1);
  assert.equal(await get("http://localhost:5174/"), 2);
  now += HOME_TTL.latest * 1000;
  assert.equal(await get("http://localhost:5173/"), 3);
  assert.equal(await get("http://localhost:5173/", "options"), 4);
  now += 61_000;
  assert.equal(await get("http://localhost:5173/?credits=2", "options"), 4);
  now += HOME_TTL.options * 1000;
  assert.equal(await get("http://localhost:5173/", "options"), 5);
  const failed = () =>
    readHomeCache(cache, new URL("http://failure.local/"), "latest", async () => {
      throw new Error("DB unavailable");
    });
  await assert.rejects(failed, /DB unavailable/);
  assert.equal(
    [...cache.entries.keys()].some((key) => key.includes("failure.local")),
    false,
  );
  const brokenCache = {
    match: async () => {
      throw new Error();
    },
    put: async () => {
      throw new Error();
    },
    delete: async () => {
      throw new Error();
    },
  };
  assert.equal(await readHomeCache(brokenCache, new URL("http://localhost/"), "stats", async () => 42), 42);
  await invalidateHomeReviews(new URL("http://localhost/"), Promise.resolve(brokenCache));
});

test("concurrent cache fill after invalidation cannot extend staleness beyond its original TTL", async () => {
  const cache = new MemoryCache();
  const url = new URL("http://localhost/");
  let now = 1_000;
  let resolveRead;
  const pendingRead = new Promise((resolve) => {
    resolveRead = resolve;
  });
  const pending = readHomeCache(
    cache,
    url,
    "latest",
    () => pendingRead,
    () => now,
  );
  await new Promise((resolve) => setImmediate(resolve));
  await invalidateHomeReviews(url, Promise.resolve(cache));
  now = 60_000;
  resolveRead("old snapshot");
  await pending;
  now = 61_001;
  assert.equal(
    await readHomeCache(
      cache,
      url,
      "latest",
      async () => "fresh",
      () => now,
    ),
    "fresh",
  );
});

test("successful course/teacher actions invalidate public data; invalid Turnstile cannot write or invalidate", async () => {
  await fixture(async (db) => {
    await executeScript(db, await migration());
    await executeScript(db, await readFile(new URL("../migrations/0006_unified_auth.sql", import.meta.url), "utf8"));
    await db
      .prepare(
        "INSERT INTO auth_users (id, issuer, subject, name, created_at, last_login_at) VALUES (1, 'https://auth.test', 'local-user', 'Local user', 1, 1)",
      )
      .run();
    const cache = new MemoryCache();
    const previousCaches = globalThis.caches;
    globalThis.caches = { open: async () => cache };
    try {
      const url = new URL("http://localhost/");
      const measured = measureDatabase(db);
      const initial = await loadHomePublicData(measured.db, url);
      const coldReads = measured.metrics.rowsRead;
      await loadHomePublicData(measured.db, new URL("http://localhost/?q=alpha&page=3"));
      assert.equal(measured.metrics.rowsRead, coldReads);

      for (const reviewType of ["course", "teacher"]) {
        const actionUrl = new URL(
          reviewType === "course"
            ? "http://localhost/courses/001?/submitReview"
            : "http://localhost/teachers/1?/submitReview",
        );
        const title = `new ${reviewType}`;
        const event = (verification) => {
          const form = new FormData();
          form.set("lid", "1");
          form.set("title", title);
          form.set("content", "local test");
          form.set("cf-turnstile-response", "local-only-token");
          form.set("csrfToken", "local-test-csrf");
          return {
            platform: { env: { DB: db, TURNSTILE_SECRET_KEY: "unit-test-secret" } },
            params: { courseId: "001", teacherId: "1" },
            url: actionUrl,
            request: new Request(actionUrl, { method: "POST", body: form, headers: { Origin: actionUrl.origin } }),
            locals: {
              getSession: async () => ({
                userId: 1,
                csrfToken: "local-test-csrf",
                name: "Local user",
                expiresAt: 9999999999,
              }),
            },
            fetch: async () => Response.json(verification),
          };
        };
        const action = (reviewType === "course" ? courses : teachers).actions.submitReview;
        const before = await db.prepare(SITE_STATS_SQL).first();
        const entriesBefore = cache.entries.size;
        for (const verification of [
          { success: false },
          { success: true, hostname: "other.test", action: "submit_review" },
          { success: true, hostname: "localhost", action: "wrong_action" },
        ]) {
          const rejected = await action(event(verification));
          assert.equal(rejected.status, 400);
          assert.deepEqual(await db.prepare(SITE_STATS_SQL).first(), before);
          assert.equal(cache.entries.size, entriesBefore);
        }
        await assert.rejects(
          action(event({ success: true, hostname: "localhost", action: "submit_review" })),
          (error) => error.status === 303,
        );
        assert.equal(cache.entries.size, 1); // Only the unchanged filter options survive.
        const after = await loadHomePublicData(measured.db, url);
        assert.equal(after.stats.reviews, before.reviews + 1);
        assert.equal(
          (
            await db
              .prepare(
                `SELECT author_id FROM ${reviewType === "course" ? "course_reviews" : "teacher_reviews"} WHERE title = ?`,
              )
              .bind(title)
              .first()
          ).author_id,
          1,
        );
        assert.equal(JSON.stringify(after).includes("author_id"), false);
        assert.equal(
          after.latestReviews.some((review) => review.title === title),
          true,
        );
        const count = await db.prepare("SELECT review_count FROM course_section WHERE lid='1'").first();
        const direct = await db.prepare("SELECT COUNT(*) AS review_count FROM course_reviews WHERE lid='1'").first();
        assert.deepEqual(count, direct);
      }
      assert.equal((await db.prepare(SITE_STATS_SQL).first()).reviews, initial.stats.reviews + 2);
    } finally {
      globalThis.caches = previousCaches;
    }
  });
});
