import "./helpers/server-imports.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { localD1, executeScript, measureDatabase } from "./helpers/local-d1.mjs";
const auth = await import("../src/lib/server/auth.ts");
const moderation = await import("../src/lib/server/moderation.ts");
const courses = await import("../src/routes/courses/[courseId]/+page.server.ts");
const teachers = await import("../src/routes/teachers/[teacherId]/+page.server.ts");
const feed = await import("../src/routes/reviews/+page.server.ts");
const { POST: mode } = await import("../src/routes/admin/mode/+server.ts");
const issuer = "https://auth.shoumc.com/api/auth";
const avatar = `https://auth.shoumc.com/api/profile/avatar/${"a".repeat(64)}.png`;

async function fixture(run) {
  const local = await localD1();
  try {
    const db = local.db;
    await executeScript(db, await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    const now = Math.floor(Date.now() / 1000);
    for (const [id, username, role] of [
      [1, "admin_user", "admin"],
      [2, "student_user", "user"],
    ]) {
      await db
        .prepare(
          "INSERT INTO auth_users(id,issuer,subject,name,username,avatar_url,role,role_expires_at,created_at,last_login_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(id, issuer, `subject-${id}`, "Original attribution", username, avatar, role, now + 300, now, now)
        .run();
      await db
        .prepare("INSERT INTO auth_sessions(token_hash,user_id,csrf_token,created_at,expires_at) VALUES (?,?,?,?,?)")
        .bind(await auth.tokenHash(String(id).repeat(43)), id, `csrf-${id}`, now, now + 3600)
        .run();
    }
    await executeScript(
      db,
      `INSERT INTO courses VALUES ('a','Alpha'),('b','Beta');
      INSERT INTO course_section(lid,course_id,college,elective_type,credits) VALUES ('s1','a','c','e',1),('s2','b','c','e',1);
      INSERT INTO teachers VALUES (1,'Teacher Alpha'),(2,'Teacher Beta');
      INSERT INTO course_reviews(id,lid,title,content,posted_at_local,author_id,is_anonymous,public_username,public_avatar_url)
      VALUES (1,'s1','Historical','Original text','2026-01-01',NULL,1,'Original stored name','Original stored avatar'),
        (2,'s1','Anonymous owned','Hidden identity','2026-01-02',2,1,'student_user','${avatar}'),
        (3,'s2','Other class','Not Alpha','2026-01-03',2,1,NULL,NULL);
      INSERT INTO teacher_reviews(id,teacher_id,title,content,posted_at_local,author_id) VALUES (1,1,'Teacher review','Classroom','2026-01-01',2);`,
    );
    await run(db);
  } finally {
    await local.close();
  }
}

function event(db, path = "/reviews", user = null, management = false, actionValues) {
  const url = new URL(path, "https://lxk.shoumc.com");
  const values = new Map();
  if (user) values.set("__Host-lxk-session", String(user).repeat(43));
  if (management) values.set(moderation.MANAGEMENT_COOKIE, "1");
  const body = new FormData();
  if (actionValues) {
    body.set("csrfToken", `csrf-${user}`);
    for (const [key, value] of Object.entries(actionValues)) body.set(key, String(value));
  }
  const result = {
    platform: { env: { DB: db, OIDC_ISSUER: issuer, TURNSTILE_SECRET_KEY: "local" } },
    url,
    params: { courseId: "a", teacherId: "1" },
    request: new Request(url, actionValues ? { method: "POST", body, headers: { Origin: url.origin } } : undefined),
    cookies: {
      get: (key) => values.get(key),
      delete: (key) => values.delete(key),
      set: (key, value) => values.set(key, value),
    },
    locals: {},
    fetch: async () => Response.json({ success: true, hostname: url.hostname, action: "submit_review" }),
  };
  let session;
  result.locals.getSession = () => (session ??= auth.readSession(result));
  return result;
}

test("anonymous projections hide stored attribution/avatar in all public loaders and forged management cookies", async () => {
  await fixture(async (db) => {
    for (const [load, path] of [
      [feed.load, "/reviews"],
      [courses.load, "/courses/a"],
      [teachers.load, "/teachers/1"],
    ]) {
      for (const user of [null, 2]) {
        const data = await load(event(db, path, user, true));
        assert.equal(data.managementMode, false);
        for (const review of data.reviews) {
          assert.equal(review.display_name, "匿名用户");
          assert.equal(review.avatar_url, null);
          for (const field of ["author_id", "author_name", "moderation", "public_username", "public_avatar_url"])
            assert.equal(Object.hasOwn(review, field), false);
        }
        assert.equal(JSON.stringify(data.reviews).includes("Original stored"), false);
      }
    }
    const stored = await db.prepare("SELECT public_username,public_avatar_url FROM course_reviews WHERE id=1").first();
    assert.deepEqual(stored, { public_username: "Original stored name", public_avatar_url: "Original stored avatar" });
  });
});

test("course and teacher submissions default anonymous, use only trusted usernames when chosen and reject arbitrary visibility", async () => {
  await fixture(async (db) => {
    for (const [route, path, table] of [
      [courses, "/courses/a?/submitReview", "course_reviews"],
      [teachers, "/teachers/1?/submitReview", "teacher_reviews"],
    ]) {
      for (const visibility of [undefined, "username"]) {
        const values = {
          title: "Local submission",
          content: "Local body",
          lid: "s1",
          "cf-turnstile-response": "local",
          name: "Impersonated",
          username: "Impersonated",
          avatar: "https://evil.test/private.png",
        };
        if (visibility) values.visibility = visibility;
        await assert.rejects(
          route.actions.submitReview(event(db, path, 2, false, values)),
          (reason) => reason.status === 303,
        );
        const row = await db.prepare(`SELECT * FROM ${table} ORDER BY id DESC LIMIT 1`).first();
        assert.equal(row.author_id, 2);
        assert.equal(row.is_anonymous, visibility ? 0 : 1);
        assert.equal(row.public_username, visibility ? "student_user" : null);
        assert.equal(row.public_avatar_url, visibility ? avatar : null);
      }
      const before = await db.prepare("SELECT reviews FROM site_stats WHERE id=1").first();
      await assert.rejects(
        route.actions.submitReview(event(db, path, 2, false, { visibility: "Impersonated" })),
        (reason) => reason.status === 400,
      );
      assert.deepEqual(await db.prepare("SELECT reviews FROM site_stats WHERE id=1").first(), before);
    }
    const named = (await feed.load(event(db))).reviews.filter((r) => r.display_name !== "匿名用户");
    assert.equal(named.length, 2);
    assert.ok(named.every((r) => r.display_name === "student_user" && r.avatar_url === avatar));
  });
});

test("management mode scopes course/teacher details and supports searchable archived inline restoration with identity intact", async () => {
  await fixture(async (db) => {
    const manage = await feed.load(
      event(db, "/reviews?type=course&q=Anonymous&target=Alpha&author=student&ownership=known", 1, true),
    );
    assert.equal(manage.total, 1);
    assert.equal(manage.reviews[0].moderation.authorId, 2);
    assert.equal(manage.reviews[0].display_name, "匿名用户");
    const original = await db.prepare("SELECT * FROM course_reviews WHERE id=2").first();
    await courses.actions.archiveReview(
      event(db, "/courses/a?/archiveReview", 1, true, {
        reviewType: "course",
        reviewId: 2,
        reason: "Local test archive",
      }),
    );
    const deleted = await courses.load(event(db, "/courses/a?status=deleted", 1, true));
    assert.equal(deleted.total, 1);
    assert.equal(deleted.reviews[0].id, 2);
    assert.equal(deleted.reviews[0].moderation.deleted, true);
    const unrelated = event(db, "/courses/b?status=deleted", 1, true);
    unrelated.params.courseId = "b";
    assert.equal((await courses.load(unrelated)).total, 0);
    assert.equal((await teachers.load(event(db, "/teachers/1?status=deleted", 1, true))).total, 0);
    const publicDeletedRequest = await feed.load(event(db, "/reviews?status=deleted", 2, true));
    assert.equal(
      publicDeletedRequest.reviews.some((r) => r.review_type === "course" && r.id === 2),
      false,
    );
    const archived = await feed.load(event(db, "/reviews?status=deleted&type=course&q=Anonymous&author=2", 1, true));
    assert.equal(archived.total, 1);
    await feed.actions.restoreReview(
      event(db, "/reviews?/restoreReview", 1, true, {
        reviewType: "course",
        reviewId: 2,
        reason: "Local test restore",
      }),
    );
    assert.deepEqual(await db.prepare("SELECT * FROM course_reviews WHERE id=2").first(), original);
  });
});

test("expired central authority cannot be reused by stale contexts or mode toggles and local email never elevates users", async () => {
  await fixture(async (db) => {
    const context = await moderation.requireAdmin(event(db, "/reviews", 1));
    await db.prepare("UPDATE auth_users SET role_expires_at=unixepoch() WHERE id=1").run();
    assert.equal(
      await moderation.archiveReview(context, "course", 2, "Expired", new URL("https://lxk.shoumc.com/reviews")),
      false,
    );
    assert.equal(await moderation.setUserBan(context, 2, true, "Expired"), false);
    assert.equal((await feed.load(event(db, "/reviews", 1, true))).managementMode, false);
    await assert.rejects(mode(event(db, "/admin/mode", 1, true, { enabled: 1 })), (reason) => reason.status === 403);
    const forged = event(db, "/admin/mode", 2, true, { enabled: 1 });
    forged.platform.env.LXK_ADMIN_EMAILS = "student@invalid.test";
    await assert.rejects(mode(forged), (reason) => reason.status === 403);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM moderation_events").first()).n, 0);
    const measured = measureDatabase(db);
    await feed.load(event(measured.db));
    assert.equal(measured.metrics.queries, 2);
  });
});

test("0008 preserves original profiles, active/archived contents and counts without assigning historical identities", async () => {
  const local = await localD1();
  try {
    const db = local.db;
    await executeScript(db, await readFile(new URL("./fixtures/schema-before-0008.sql", import.meta.url), "utf8"));
    await executeScript(
      db,
      `INSERT INTO courses VALUES ('a','A');
      INSERT INTO course_section(lid,course_id,college,elective_type,credits) VALUES ('s1','a','c','e',1);
      INSERT INTO auth_users(id,issuer,subject,name,created_at,last_login_at) VALUES (1,'${issuer}','old-user','Historical original',1,1);
      INSERT INTO course_reviews(id,lid,title,content,posted_at_local,author_id) VALUES (44,'s1','Original','Original content','2026-01-01',1);
      INSERT INTO moderation_review_archive(review_type,review_id,lid,title,content,posted_at_local,author_id,deleted_by,deleted_at,reason,operation_id) VALUES ('course',43,'s1','Archived','Archived content','2026-01-01',1,1,1,'Original reason','original-operation');`,
    );
    const stats = await db.prepare("SELECT * FROM site_stats").first();
    await executeScript(
      db,
      await readFile(new URL("../migrations/0008_profiles_and_review_visibility.sql", import.meta.url), "utf8"),
    );
    assert.deepEqual(await db.prepare("SELECT * FROM site_stats").first(), stats);
    const user = await db.prepare("SELECT name,username,role,role_expires_at FROM auth_users").first();
    assert.deepEqual(user, { name: "Historical original", username: null, role: "user", role_expires_at: 0 });
    for (const table of ["course_reviews", "moderation_review_archive"]) {
      const row = await db
        .prepare(`SELECT author_id,is_anonymous,public_username,public_avatar_url FROM ${table}`)
        .first();
      assert.deepEqual(row, { author_id: 1, is_anonymous: 1, public_username: null, public_avatar_url: null });
    }
  } finally {
    await local.close();
  }
});
