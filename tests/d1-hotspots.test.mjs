import "./helpers/server-imports.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  localD1,
  executeScript,
  migration,
  profileMigrations,
  MemoryCache,
  measureDatabase,
} from "./helpers/local-d1.mjs";
const { EXPIRED_LOGIN_SQL, EXPIRED_SESSION_SQL } = await import("../src/lib/server/auth.ts");
const { loadSimilarCandidates, HOME_TTL } = await import("../src/lib/server/home-cache.ts");
async function fixture(run) {
  const local = await localD1();
  try {
    await executeScript(
      local.db,
      await readFile(new URL("./fixtures/schema-before-0005.sql", import.meta.url), "utf8"),
    );
    await executeScript(local.db, await migration());
    await executeScript(local.db, await profileMigrations());
    await run(local.db);
  } finally {
    await local.close();
  }
}
test("expiry cleanup seeks primary keys, bounds removals and retains unexpired sessions", async () =>
  fixture(async (db) => {
    await executeScript(
      db,
      `INSERT INTO auth_users(id,issuer,subject,name,created_at,last_login_at) VALUES(1,'issuer','subject','fixture',0,0);
 WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<64)
 INSERT INTO auth_login_transactions SELECT printf('%064x',x),printf('%064x',x),'verifier','nonce','/',0,10000 FROM n;
 WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<60)
 INSERT INTO auth_sessions SELECT printf('%064x',x),1,'csrf',0,CASE WHEN x<=55 THEN 1 ELSE 10000 END FROM n;`,
    );
    await db.prepare("ANALYZE").run();
    const legacy =
      "DELETE FROM auth_login_transactions WHERE state_hash IN (SELECT state_hash FROM auth_login_transactions WHERE expires_at<=? ORDER BY expires_at LIMIT 50)";
    // Reproduce the outer SCAN observed by production EXPLAIN independently of
    // the local planner's statistics (which may already choose the good plan).
    const before = await db
      .prepare(legacy.replace("auth_login_transactions WHERE", "auth_login_transactions NOT INDEXED WHERE"))
      .bind(500)
      .run();
    const after = await db.prepare(EXPIRED_LOGIN_SQL).bind(500).run();
    assert.ok(after.meta.rows_read < before.meta.rows_read, `${before.meta.rows_read} -> ${after.meta.rows_read}`);
    assert.ok(after.meta.rows_read <= 2);
    console.log(
      `observed outer-scan baseline vs indexed cleanup rows_read: ${before.meta.rows_read} -> ${after.meta.rows_read}`,
    );
    for (const sql of [EXPIRED_LOGIN_SQL, EXPIRED_SESSION_SQL]) {
      const plan = (
        await db
          .prepare("EXPLAIN QUERY PLAN " + sql)
          .bind(500)
          .all()
      ).results
        .map((r) => r.detail)
        .join("\n");
      assert.match(plan, /SEARCH .* USING COVERING INDEX sqlite_autoindex_auth_/);
      assert.doesNotMatch(plan, /SCAN auth_/);
    }
    await db.prepare(EXPIRED_SESSION_SQL).bind(500).run();
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM auth_sessions").first()).n, 10);
    await db.prepare(EXPIRED_SESSION_SQL).bind(500).run();
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM auth_sessions").first()).n, 5);
  }));
test("similar candidate cache eliminates repeat SQL, partitions filters and expires without caching errors", async () =>
  fixture(async (db) => {
    await executeScript(
      db,
      `INSERT INTO courses VALUES('one','One'),('two','Two');
 INSERT INTO course_section(lid,course_id,college,elective_type,credits,attribute) VALUES('1','one','学院','必修',1,''),('2','two','学院二','必修',1,'');`,
    );
    const cache = new MemoryCache(),
      url = new URL("https://fixture.test/courses/one?lid=1");
    const measured = measureDatabase(db);
    let now = 1000;
    const get = (college = "学院", credits = 1) =>
      loadSimilarCandidates(measured.db, url, college, credits, Promise.resolve(cache), () => now);
    assert.equal((await get()).length, 1);
    const cold = measured.metrics.rowsRead,
      queries = measured.metrics.queries;
    assert.equal((await get()).length, 1);
    assert.equal(measured.metrics.rowsRead, cold);
    assert.equal(measured.metrics.queries, queries);
    assert.equal((await get("学院二"))[0].course_id, "two");
    assert.equal((await get("学院", 0.5)).length, 0);
    now += HOME_TTL.similar * 1000;
    await get();
    assert.ok(measured.metrics.rowsRead > cold);
    const broken = {
      prepare() {
        throw new Error("offline");
      },
    };
    await assert.rejects(
      loadSimilarCandidates(broken, url, "failure", 1, Promise.resolve(cache), () => now),
      /offline/,
    );
    assert.equal(
      [...cache.entries.keys()].some((key) => key.includes("failure")),
      false,
    );
  }));
