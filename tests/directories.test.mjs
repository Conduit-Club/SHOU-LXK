import "./helpers/server-imports.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { localD1, executeScript, MemoryCache, measureDatabase } from "./helpers/local-d1.mjs";
const { load: home } = await import("../src/routes/+page.server.ts");
const { load: reviews } = await import("../src/routes/reviews/+page.server.ts");
const { load: teachers } = await import("../src/routes/teachers/+page.server.ts");
const { handleError } = await import("../src/hooks.server.ts");
const { newRun, jump, step, GROUND, STUDENT_X } = await import("../src/lib/runner.ts");

test("landing and independent directories preserve search, ordering, pagination and cache boundaries", async () => {
  const local = await localD1();
  const previous = globalThis.caches;
  const cache = new MemoryCache();
  globalThis.caches = { open: async () => cache };
  try {
    const db = local.db;
    await executeScript(db, await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    await executeScript(
      db,
      `
      INSERT INTO courses VALUES ('001','课程名称不属于点评搜索');
      INSERT INTO course_section(lid,course_id,college,elective_type,credits) VALUES ('s1','001','c','t',2);
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 20)
      INSERT INTO teachers SELECT x, '老师' || printf('%02d',x) FROM n;
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 20)
      INSERT INTO course_reviews(id,lid,title,content,posted_at_local) SELECT x,'s1','Title ' || x,'实验课 100%_','2026-01-01 00:00:00' FROM n;
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 20)
      INSERT INTO teacher_reviews(id,teacher_id,title,content,posted_at_local) SELECT x,1,'Title ' || x,'Teaching','2026-01-01 00:00:00' FROM n;
    `,
    );
    const event = (path, database = db) => ({
      platform: { env: { DB: database } },
      url: new URL(path, "http://local.test"),
    });
    const measured = measureDatabase(db);
    const first = await home(event("/", measured.db));
    assert.equal(measured.metrics.queries, 4);
    assert.equal(first.latestReviews.length, 5);
    assert.equal(first.newTeachers.length, 5);
    assert.equal(first.newCourses.length, 1);
    assert.equal(first.newTeachers[0].id, 20);
    const warm = measureDatabase(db);
    assert.deepEqual(await home(event("/?irrelevant=1", warm.db)), first);
    assert.equal(warm.metrics.rowsRead, 0);
    assert.equal(warm.metrics.queries, 0);
    const seen = [];
    for (let page = 1; page <= 4; page++) {
      const result = await reviews(event(`/reviews?page=${page}`));
      assert.equal(result.total, 40);
      seen.push(...result.reviews.map((r) => `${r.review_type}:${r.id}`));
    }
    assert.deepEqual(
      seen,
      ["course", "teacher"].flatMap((type) => Array.from({ length: 20 }, (_, i) => `${type}:${20 - i}`)),
    );
    for (const [query, expected] of [
      ["title", 40],
      ["实验", 20],
      ["100%_", 20],
      ["%", 20],
      ["不属于点评搜索", 0],
      ["' OR 1=1 --", 0],
    ]) {
      const result = await reviews(event(`/reviews?q=${encodeURIComponent(query)}&page=999`));
      assert.equal(result.total, expected, query);
      assert.equal(result.page, Math.max(1, Math.ceil(expected / 12)));
    }
    assert.equal((await reviews(event("/reviews?page=-2"))).page, 1);
    const teacher = await teachers(event("/teachers?q=老师01"));
    assert.deepEqual(
      teacher.teachers.map((r) => r.id),
      [1],
    );
    const last = await teachers(event("/teachers?page=999"));
    assert.equal(last.total, 20);
    assert.equal(last.page, 2);
    assert.equal(last.teachers.length, 8);
    assert.equal((await teachers(event("/teachers?q=missing"))).total, 0);
  } finally {
    globalThis.caches = previous;
    await local.close();
  }
});

test("public error payload never contains provider or quota information", async () => {
  const result = await handleError({
    kind: "unknown",
    error: new Error("D1_ERROR quota database_id secret SQL SELECT *"),
    event: {},
  });
  assert.deepEqual(result, { message: "加载失败，请稍后重试。" });
  await assert.rejects(home({ platform: { env: {} }, url: new URL("http://local/") }), (error) => {
    assert.equal(error.body.message, "加载失败，请稍后重试。");
    return true;
  });
});

test("student can jump each building height, collect GPA once, and restart after collision", () => {
  for (const height of [30, 46, 62]) {
    const run = newRun();
    run.obstacles.push({ x: STUDENT_X + 90, width: 34, height });
    jump(run);
    for (let i = 0; i < 60; i++) step(run, 1 / 60);
    assert.equal(run.over, false, `building ${height}`);
    assert.equal(run.y, 0);
  }
  const run = newRun();
  run.points.push({ x: STUDENT_X + 15, y: GROUND - 23, collected: false });
  step(run, 1 / 60);
  step(run, 1 / 60);
  assert.equal(run.gpa, 1);
  run.obstacles.push({ x: STUDENT_X + 10, width: 34, height: 30 });
  step(run, 1 / 60);
  assert.equal(run.over, true);
  const distance = run.distance;
  step(run, 1);
  assert.equal(run.distance, distance);
  assert.equal(newRun().gpa, 0);
});
