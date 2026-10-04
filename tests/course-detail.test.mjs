import "./helpers/server-imports.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { localD1, executeScript, measureDatabase } from "./helpers/local-d1.mjs";
const { load } = await import("../src/routes/courses/[courseId]/+page.server.ts");

test("course detail scopes counts, recommendations, pagination and writing intent", async () => {
  const local = await localD1();
  try {
    const db = local.db;
    await executeScript(db, await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    await executeScript(
      db,
      `
      INSERT INTO courses VALUES ('a','Current'),('b','Similar'),('c','Other'),('d','Empty');
      INSERT INTO course_section(lid,course_id,college,elective_type,credits,attribute) VALUES
      ('s1','a','学院','选修',2,'属性'),('s2','a','学院','选修',2,NULL),
      ('s3','b','学院','选修',2,NULL),('s4','b','学院','选修',2,NULL),
      ('s5','c','其他学院','选修',2,NULL);
      INSERT INTO teachers VALUES (1,'教师');
      INSERT INTO course_section_teachers VALUES ('s1',1,1);
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 21)
      INSERT INTO course_reviews(id,lid,title,content,posted_at_local) SELECT x,'s1','Title','Content','2026-01-01' FROM n;
      INSERT INTO course_reviews(id,lid,title,content,posted_at_local) VALUES (22,'s2','Other class','Content','2026-01-02');
    `,
    );
    const event = (id, query = "", database = db) => ({
      params: { courseId: id },
      platform: { env: { DB: database } },
      url: new URL(`http://local.test/courses/${id}${query}`),
    });
    const measured = measureDatabase(db);
    const all = await load(event("a", "", measured.db));
    assert.equal(all.total, 22);
    assert.equal(all.writing, false);
    assert.equal(all.reviews[0].id, 22);
    assert.deepEqual(
      all.similarCourses.map((c) => c.course_id),
      ["b"],
    );
    assert.equal(all.sections[0].teachers[0].name, "教师");
    assert.equal(all.sections[0].attribute, "属性");
    assert.equal(measured.metrics.queries, 5);
    const selected = await load(event("a", "?lid=s1&page=9&write=1"));
    assert.equal(selected.total, 21);
    assert.equal(selected.page, 2);
    assert.equal(selected.reviews.length, 1);
    assert.equal(selected.writing, true);
    await db.prepare("DELETE FROM course_reviews WHERE id=1").run();
    assert.equal((await load(event("a", "?lid=s1"))).total, 20);
    await assert.rejects(load(event("a", "?lid=s5")), (e) => e.status === 404);
    const empty = await load(event("d"));
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.similarCourses, []);
    assert.deepEqual(empty.sections, []);
  } finally {
    await local.close();
  }
});
