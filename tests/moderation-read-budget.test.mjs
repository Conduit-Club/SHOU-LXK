import "./helpers/server-imports.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { localD1, executeScript, measureDatabase } from "./helpers/local-d1.mjs";
import { legacyManagedReviews } from "./helpers/legacy-moderation.mjs";
const { loadManagedReviews } = await import("../src/lib/server/moderation.ts");
const issuer = "https://auth.shoumc.com/api/auth";
const url = (query) => new URL("/admin" + query, "https://local-budget.invalid");
const context = (db) => ({ db, actor: { userId: 1 }, issuer });

async function fixture(run) {
  const local = await localD1();
  try {
    const db = local.db;
    await executeScript(db, await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    await executeScript(
      db,
      `
      INSERT INTO courses VALUES ('a','Course Alpha'),('b','Course Beta');
      INSERT INTO course_section(lid,course_id,college,elective_type,credits) VALUES
        ('s1','a','c','e',2),('s2','a','c','e',2),('s3','b','c','e',2);
      INSERT INTO teachers VALUES (1,'Teacher Alpha'),(2,'Teacher Beta');
      INSERT INTO auth_users(id,issuer,subject,name,username,role,created_at,last_login_at) VALUES
        (1,'${issuer}','admin','Admin','admin_user','admin',1,1),
        (2,'${issuer}','alice','Private Alice','alice2','user',1,1),
        (3,'${issuer}','second-admin','Private Bob','bob_admin','admin',1,1);
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<400)
      INSERT INTO course_reviews(id,lid,title,content,posted_at_local,author_id,is_anonymous,public_username,public_avatar_url)
      SELECT x,'s'||(x%3+1),'Title '||x,CASE WHEN x%4=0 THEN 'Needle 100%_ 教师' ELSE 'Other' END,
        '2026-01-'||printf('%02d',x%5+1),CASE WHEN x%3=0 THEN NULL WHEN x%3=1 THEN 2 ELSE 3 END,
        x%2,'saved_user','https://auth.shoumc.com/api/profile/avatar/${"a".repeat(64)}.png' FROM n;
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<300)
      INSERT INTO teacher_reviews(id,teacher_id,title,content,posted_at_local,author_id,is_anonymous,public_username,public_avatar_url)
      SELECT x,x%2+1,'Title '||x,CASE WHEN x%4=0 THEN 'Needle 100%_ 教师' ELSE 'Other' END,
        '2026-01-'||printf('%02d',x%5+1),CASE WHEN x%3=0 THEN NULL WHEN x%3=1 THEN 2 ELSE 3 END,
        x%2,'saved_user','https://auth.shoumc.com/api/profile/avatar/${"a".repeat(64)}.png' FROM n;
      UPDATE auth_users SET banned_at=1 WHERE id=2;
      INSERT INTO moderation_review_archive(review_type,review_id,lid,teacher_id,title,content,posted_at_local,
        author_id,is_anonymous,public_username,public_avatar_url,deleted_by,deleted_at,reason,operation_id)
      SELECT 'course',id,lid,NULL,title,content,posted_at_local,author_id,is_anonymous,public_username,public_avatar_url,
        1,1700000000+id%4,'Test archive','course-'||id FROM course_reviews WHERE id%10=0;
      INSERT INTO moderation_review_archive(review_type,review_id,lid,teacher_id,title,content,posted_at_local,
        author_id,is_anonymous,public_username,public_avatar_url,deleted_by,deleted_at,reason,operation_id)
      SELECT 'teacher',id,NULL,teacher_id,title,content,posted_at_local,author_id,is_anonymous,public_username,public_avatar_url,
        1,1700000000+id%4,'Test archive','teacher-'||id FROM teacher_reviews WHERE id%10=0;
      DELETE FROM course_reviews WHERE id%10=0;
      DELETE FROM teacher_reviews WHERE id%10=0;
    `,
    );
    await run(db);
  } finally {
    await local.close();
  }
}

test("managed count/candidates preserve all filters, archive ordering, scope, author protection and paging", async () => {
  await fixture(async (db) => {
    const filters = [
      {},
      { type: "course" },
      { type: "teacher" },
      { q: "needle" },
      { q: "100%_" },
      { q: "' OR 1=1 --" },
      { target: "alpha" },
      { target: "b" },
      { target: "s1" },
      { author: "ali" },
      { author: "#2" },
      { author: "3" },
      { author: "Private" },
      { ownership: "known" },
      { ownership: "legacy" },
      { banned: "yes" },
      { banned: "no" },
      { type: "course", q: "needle", author: "#2", banned: "yes", ownership: "known" },
      { target: "alpha", banned: "no", ownership: "known" },
    ];
    for (const status of ["active", "deleted"]) {
      for (const fields of filters) {
        for (const sort of ["latest", "oldest"]) {
          for (const page of [1, 999]) {
            const query = url("?" + new URLSearchParams({ ...fields, status, sort, page: String(page) }));
            const actual = await loadManagedReviews(context(db), query);
            assert.deepEqual(actual, await legacyManagedReviews(context(db), query), query.href);
            assert.ok(actual.reviews.every((row) => row.author_id !== 3 || !row.canBan));
            assert.ok(actual.reviews.every((row) => row.display_name !== "匿名用户" || row.avatar_url === null));
          }
        }
      }
    }
    for (const scope of [
      { kind: "course", courseId: "a" },
      { kind: "course", courseId: "a", lid: "s1" },
      { kind: "course", courseId: "a", lid: "s3" },
      { kind: "teacher", teacherId: 1 },
    ]) {
      for (const query of [
        "",
        "?page=2&sort=oldest",
        "?status=deleted&sort=oldest",
        "?q=needle&ownership=known",
        "?target=alpha&banned=no",
      ]) {
        assert.deepEqual(
          await loadManagedReviews(context(db), url(query), scope),
          await legacyManagedReviews(context(db), url(query), scope),
        );
      }
    }
  });
});

test("default moderation paging uses a single live counter and only joins the selected page", async () => {
  await fixture(async (db) => {
    const before = measureDatabase(db);
    const expected = await legacyManagedReviews(context(before.db), url(""));
    const after = measureDatabase(db);
    assert.deepEqual(await loadManagedReviews(context(after.db), url("")), expected);
    assert.equal(after.statements[0].rowsRead, 1);
    assert.equal(after.metrics.rowsWritten, 0);
    assert.ok(
      after.metrics.rowsRead < before.metrics.rowsRead / 4,
      JSON.stringify({ before: before.metrics, after: after.metrics }),
    );
    await executeScript(
      db,
      `
      WITH RECURSIVE n(x) AS (VALUES(1000) UNION ALL SELECT x+1 FROM n WHERE x<5999)
      INSERT INTO teachers SELECT x,'Unrelated teacher '||x FROM n;
      WITH RECURSIVE n(x) AS (VALUES(1000) UNION ALL SELECT x+1 FROM n WHERE x<5999)
      INSERT INTO courses SELECT 'unused-'||x,'Unrelated course '||x FROM n;
    `,
    );
    const expanded = measureDatabase(db);
    assert.deepEqual(await loadManagedReviews(context(expanded.db), url("")), expected);
    assert.ok(expanded.metrics.rowsRead < 300, JSON.stringify(expanded.metrics));
    assert.equal(expanded.metrics.rowsWritten, 0);
    const empty = measureDatabase(db);
    assert.equal((await loadManagedReviews(context(empty.db), url("?q=__missing_review__"))).total, 0);
    assert.equal(empty.metrics.queries, 1, "an empty count must not run a second full search");
    const total = expected.total;
    await db
      .prepare(
        "INSERT INTO teacher_reviews(teacher_id,title,content,posted_at_local) VALUES(1,'Fresh','Fresh','2026-02-01')",
      )
      .run();
    assert.equal((await loadManagedReviews(context(db), url(""))).total, total + 1);
  });
});
