import "./helpers/server-imports.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { localD1, executeScript, measureDatabase, MemoryCache } from "./helpers/local-d1.mjs";
const auth = await import("../src/lib/server/auth.ts");
const moderation = await import("../src/lib/server/moderation.ts");
const { actions, load: adminLoad } = await import("../src/routes/admin/+page.server.ts");
const { load: publicFeed } = await import("../src/routes/reviews/+page.server.ts");
const { loadLandingData } = await import("../src/lib/server/home-cache.ts");
const courses = await import("../src/routes/courses/[courseId]/+page.server.ts");
const teachers = await import("../src/routes/teachers/[teacherId]/+page.server.ts");
const issuer = "https://auth.shoumc.com/api/auth";
const adminEmail = "admin@invalid.test";
const secondAdminEmail = "second-admin@invalid.test";
const allowed = `${adminEmail}, ${secondAdminEmail}`;
const cookie = (token) => ({ get: (name) => (name === "__Host-lxk-session" ? token : undefined), delete() {} });
const token = (id) => String(id).repeat(43);

function event(db, userId = 1, path = "/admin", init, emails = allowed) {
  const url = new URL(path, "https://lxk.shoumc.com");
  const result = {
    platform: { env: { DB: db, OIDC_ISSUER: issuer, LXK_ADMIN_EMAILS: emails, TURNSTILE_SECRET_KEY: "local-secret" } },
    url,
    request: new Request(url, init),
    cookies: cookie(userId === null ? undefined : token(userId)),
    locals: {},
  };
  let session;
  result.locals.getSession = () => (session ??= auth.readSession(result));
  return result;
}

async function fixture(run) {
  const local = await localD1();
  try {
    const db = local.db;
    await executeScript(db, await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    const now = Math.floor(Date.now() / 1000);
    for (const [id, email] of [
      [1, adminEmail],
      [2, "student@invalid.test"],
      [3, secondAdminEmail],
    ]) {
      await db
        .prepare(
          "INSERT INTO auth_users(id,issuer,subject,name,created_at,last_login_at,verified_email_hash) VALUES (?,?,?,?,?,?,?)",
        )
        .bind(id, issuer, `subject-${id}`, `Local user ${id}`, now, now, await auth.tokenHash(email))
        .run();
      await db
        .prepare("INSERT INTO auth_sessions(token_hash,user_id,csrf_token,created_at,expires_at) VALUES (?,?,?,?,?)")
        .bind(await auth.tokenHash(token(id)), id, `csrf-${id}`, now, now + 3600)
        .run();
    }
    await executeScript(
      db,
      `INSERT INTO courses VALUES ('001','Local course');
      INSERT INTO course_section(lid,course_id,college,elective_type,credits) VALUES ('s1','001','c','e',1);
      INSERT INTO teachers VALUES (1,'Local teacher');
      INSERT INTO course_reviews(id,lid,title,content,posted_at_local,author_id) VALUES (10,'s1','Legacy','Legacy content','2026-01-01',NULL),(11,'s1','Student','Student content','2026-01-02',2);
      INSERT INTO teacher_reviews(id,teacher_id,title,content,posted_at_local,author_id) VALUES (20,1,'Legacy teacher','Legacy teacher content','2026-01-01',NULL),(21,1,'Student teacher','Teacher content','2026-01-02',2);`,
    );
    await run(db);
  } finally {
    await local.close();
  }
}

async function action(db, actionName, values, userId = 1, origin = "https://lxk.shoumc.com", csrf = `csrf-${userId}`) {
  const body = new FormData();
  body.set("csrfToken", csrf);
  for (const [key, value] of Object.entries(values)) body.set(key, String(value));
  return actions[actionName](
    event(db, userId, `/admin?/${actionName}`, { method: "POST", headers: { Origin: origin }, body }),
  );
}

async function checkCounts(db, total) {
  assert.equal((await db.prepare("SELECT reviews FROM site_stats WHERE id=1").first()).reviews, total);
  const violations = await db
    .prepare(
      "SELECT cs.lid FROM course_section cs WHERE cs.review_count<>(SELECT COUNT(*) FROM course_reviews r WHERE r.lid=cs.lid)",
    )
    .all();
  assert.deepEqual(violations.results, []);
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
}

test("only verified issuer-bound server allowlist administrators may read or mutate moderation", async () => {
  await fixture(async (db) => {
    for (const [id, status] of [
      [null, 401],
      [2, 403],
    ]) {
      await assert.rejects(adminLoad(event(db, id)), (reason) => reason.status === status);
      await assert.rejects(
        action(db, "archiveReview", { reviewType: "course", reviewId: 11, reason: "Test" }, id),
        (reason) => reason.status === status,
      );
    }
    for (const [origin, csrf] of [
      ["https://evil.test", "csrf-1"],
      ["https://lxk.shoumc.com", "wrong"],
    ]) {
      await assert.rejects(
        action(db, "archiveReview", { reviewType: "course", reviewId: 11, reason: "Test" }, 1, origin, csrf),
        (reason) => reason.status === 403,
      );
    }
    for (const values of [
      { reviewType: "other", reviewId: 11, reason: "Test" },
      { reviewType: "course", reviewId: "11 OR 1=1", reason: "Test" },
      { reviewType: "course", reviewId: 11, reason: " " },
    ]) {
      await assert.rejects(action(db, "archiveReview", values), (reason) => reason.status === 400);
    }
    const wrongIssuer = event(db, 1);
    wrongIssuer.platform.env.OIDC_ISSUER = "https://other.invalid/api/auth";
    await assert.rejects(adminLoad(wrongIssuer), (reason) => reason.status === 403);
    await assert.rejects(adminLoad(event(db, 1, "/admin", undefined, "")), (reason) => reason.status === 403);
    const admin = await adminLoad(event(db, 1));
    assert.equal(admin.reviews.length, 2);
    assert.equal(admin.reviews.find((r) => r.id === 10).canBan, false);
    assert.equal(JSON.stringify(admin).includes("email_hash"), false);
    assert.equal(JSON.stringify(admin).includes(adminEmail), false);
    await checkCounts(db, 4);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM moderation_events").first()).n, 0);
  });
});

test("archive and restore preserve IDs and authors, update counts once, and invalidate only public review/stat caches", async () => {
  await fixture(async (db) => {
    const cache = new MemoryCache();
    const previous = globalThis.caches;
    globalThis.caches = { open: async () => cache };
    try {
      const url = new URL("https://lxk.shoumc.com");
      const before = await loadLandingData(db, url);
      assert.equal(before.stats.reviews, 4);
      for (const [kind, id] of [
        ["course", 11],
        ["teacher", 21],
      ]) {
        const table = kind === "course" ? "course_reviews" : "teacher_reviews";
        const original = await db.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(id).first();
        await action(db, "archiveReview", { reviewType: kind, reviewId: id, reason: "Local archive test" });
        const after = await loadLandingData(db, url);
        assert.equal(after.stats.reviews, 3);
        assert.equal(
          after.latestReviews.some((r) => r.id === id && r.review_type === kind),
          false,
        );
        assert.equal(await db.prepare(`SELECT id FROM ${table} WHERE id=?`).bind(id).first(), null);
        const archived = await db
          .prepare("SELECT * FROM moderation_review_archive WHERE review_type=? AND review_id=?")
          .bind(kind, id)
          .first();
        assert.equal(archived.author_id, original.author_id);
        assert.equal(archived.content, original.content);
        const repeated = await action(db, "archiveReview", { reviewType: kind, reviewId: id, reason: "Repeat" });
        assert.equal(repeated.status, 409);
        await checkCounts(db, 3);
        // Removing the maximum live ID must not let a new review steal it.
        const reference = kind === "course" ? "lid" : "teacher_id";
        const inserted = await db
          .prepare(
            `INSERT INTO ${table}(${reference},title,content,posted_at_local,author_id) VALUES (?,'New','New content','2026-01-03',2)`,
          )
          .bind(kind === "course" ? "s1" : 1)
          .run();
        assert.ok(inserted.meta.last_row_id > id);
        await action(db, "restoreReview", { reviewType: kind, reviewId: id, reason: "Local restoration test" });
        assert.deepEqual(await db.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(id).first(), original);
        assert.equal(
          (await action(db, "restoreReview", { reviewType: kind, reviewId: id, reason: "Repeat" })).status,
          409,
        );
        await checkCounts(db, 5);
        await db.prepare(`DELETE FROM ${table} WHERE id=?`).bind(inserted.meta.last_row_id).run();
        await checkCounts(db, 4);
        const feed = await publicFeed({
          platform: { env: { DB: db } },
          url: new URL("https://lxk.shoumc.com/reviews"),
        });
        assert.equal(JSON.stringify(feed).includes("author_id"), false);
        assert.equal(JSON.stringify(feed).includes("email_hash"), false);
      }
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM moderation_events").first()).n, 4);
    } finally {
      globalThis.caches = previous;
    }
  });
});

test("ban revokes every local session, blocks race-time writes and session creation, protects administrators, and allows historical restoration", async () => {
  await fixture(async (db) => {
    const now = Math.floor(Date.now() / 1000);
    await db
      .prepare(
        "INSERT INTO auth_sessions(token_hash,user_id,csrf_token,created_at,expires_at) VALUES (?,2,'second',?,?)",
      )
      .bind(await auth.tokenHash("x".repeat(43)), now, now + 3600)
      .run();
    const cachedStudent = await auth.readSession(event(db, 2));
    for (const id of [1, 3]) {
      await assert.rejects(
        action(db, "banUser", { userId: id, reason: "Should be protected" }),
        (reason) => reason.status === 400,
      );
    }
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM moderation_events").first()).n, 0);
    await action(db, "archiveReview", { reviewType: "course", reviewId: 11, reason: "Before ban" });
    await action(db, "banUser", { userId: 2, reason: "Local test ban" });
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id=2").first()).n, 0);
    assert.equal(await auth.readSession(event(db, 2)), null);
    assert.equal(
      (await db.prepare("SELECT ban_reason FROM auth_users WHERE id=2").first()).ban_reason,
      "Local test ban",
    );
    await assert.rejects(
      db
        .prepare(
          "INSERT INTO auth_sessions(token_hash,user_id,csrf_token,created_at,expires_at) VALUES (?,2,'new',?,?)",
        )
        .bind(await auth.tokenHash("y".repeat(43)), now, now + 3600)
        .run(),
      /LXK_USER_BANNED/,
    );
    for (const [module, path] of [
      [courses, "/courses/001?/submitReview"],
      [teachers, "/teachers/1?/submitReview"],
    ]) {
      const form = new FormData();
      for (const [name, value] of [
        ["csrfToken", cachedStudent.csrfToken],
        ["title", "Race"],
        ["content", "Race content"],
        ["lid", "s1"],
        ["cf-turnstile-response", "local"],
      ])
        form.set(name, value);
      const request = event(db, 2, path, { method: "POST", headers: { Origin: "https://lxk.shoumc.com" }, body: form });
      request.locals.getSession = async () => cachedStudent;
      request.params = { courseId: "001", teacherId: "1" };
      request.fetch = async () => Response.json({ success: true, hostname: "lxk.shoumc.com", action: "submit_review" });
      await assert.rejects(module.actions.submitReview(request), (reason) => reason.status === 403);
    }
    assert.equal((await action(db, "banUser", { userId: 2, reason: "Repeat" })).status, 409);
    // Restore retains the banned author's original association; it is not a
    // new submission and does not restore that user's session or permissions.
    await action(db, "restoreReview", { reviewType: "course", reviewId: 11, reason: "Restore historical review" });
    assert.equal((await db.prepare("SELECT author_id FROM course_reviews WHERE id=11").first()).author_id, 2);
    await checkCounts(db, 4);
    await action(db, "unbanUser", { userId: 2, reason: "Local test lift" });
    assert.equal((await db.prepare("SELECT banned_at FROM auth_users WHERE id=2").first()).banned_at, null);
    assert.equal(await auth.readSession(event(db, 2)), null);
    assert.equal((await action(db, "unbanUser", { userId: 2, reason: "Repeat" })).status, 409);
    const audit = await db.prepare("SELECT action FROM moderation_events ORDER BY created_at, rowid").all();
    assert.deepEqual(
      audit.results.map((r) => r.action),
      ["archive_review", "ban_user", "restore_review", "unban_user"],
    );
  });
});

test("stale administrator permission and protected-author changes cannot mutate after authority changes", async () => {
  await fixture(async (db) => {
    const context = await moderation.requireAdmin(event(db, 1));
    await db.prepare("DELETE FROM auth_sessions WHERE user_id=1").run();
    assert.equal(
      await moderation.archiveReview(context, "course", 11, "Stale", new URL("https://lxk.shoumc.com/admin")),
      false,
    );
    assert.equal(await moderation.setUserBan(context, 2, true, "Stale"), false);
    await checkCounts(db, 4);
    assert.equal((await db.prepare("SELECT banned_at FROM auth_users WHERE id=2").first()).banned_at, null);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM moderation_events").first()).n, 0);
  });
  await fixture(async (db) => {
    const context = await moderation.requireAdmin(event(db, 1));
    await db
      .prepare("UPDATE auth_users SET verified_email_hash=? WHERE id=1")
      .bind(await auth.tokenHash("removed-admin@invalid.test"))
      .run();
    assert.equal(
      await moderation.archiveReview(
        context,
        "teacher",
        21,
        "Changed binding",
        new URL("https://lxk.shoumc.com/admin"),
      ),
      false,
    );
    assert.equal(await moderation.setUserBan(context, 2, true, "Changed binding"), false);
    await checkCounts(db, 4);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM moderation_events").first()).n, 0);
  });
});

test("audit failure rolls back archive, restore and ban state together with counters and sessions", async () => {
  await fixture(async (db) => {
    const context = await moderation.requireAdmin(event(db, 1));
    await executeScript(
      db,
      "CREATE TRIGGER local_test_audit_failure BEFORE INSERT ON moderation_events BEGIN SELECT RAISE(ABORT,'LOCAL_AUDIT_FAILURE'); END;",
    );
    await assert.rejects(
      moderation.archiveReview(context, "course", 11, "Rollback", new URL("https://lxk.shoumc.com/admin")),
      /LOCAL_AUDIT_FAILURE/,
    );
    await assert.rejects(moderation.setUserBan(context, 2, true, "Rollback"), /LOCAL_AUDIT_FAILURE/);
    assert.ok(await auth.readSession(event(db, 2)));
    assert.equal((await db.prepare("SELECT banned_at FROM auth_users WHERE id=2").first()).banned_at, null);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM moderation_review_archive").first()).n, 0);
    await checkCounts(db, 4);
    await executeScript(db, "DROP TRIGGER local_test_audit_failure");
    await moderation.archiveReview(context, "teacher", 21, "Archive", new URL("https://lxk.shoumc.com/admin"));
    await executeScript(
      db,
      "CREATE TRIGGER local_test_audit_failure BEFORE INSERT ON moderation_events BEGIN SELECT RAISE(ABORT,'LOCAL_AUDIT_FAILURE'); END;",
    );
    await assert.rejects(
      moderation.restoreReview(context, "teacher", 21, "Rollback restore", new URL("https://lxk.shoumc.com/admin")),
      /LOCAL_AUDIT_FAILURE/,
    );
    assert.equal(await db.prepare("SELECT id FROM teacher_reviews WHERE id=21").first(), null);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM moderation_review_archive").first()).n, 1);
    await checkCounts(db, 3);
  });
});

test("admin review/audit pagination is bounded and visitor landing budget remains unchanged", async () => {
  await fixture(async (db) => {
    await executeScript(
      db,
      "WITH RECURSIVE n(x) AS (VALUES(30) UNION ALL SELECT x+1 FROM n WHERE x<55) INSERT INTO course_reviews(id,lid,title,content,posted_at_local) SELECT x,'s1','Legacy','Content','2026-01-01' FROM n;",
    );
    const first = await adminLoad(event(db, 1));
    const last = await adminLoad(event(db, 1, "/admin?page=999"));
    assert.equal(first.reviews.length, 20);
    assert.equal(last.page, 2);
    assert.equal(last.reviews.length, 8);
    const measured = measureDatabase(db);
    const publicData = await loadLandingData(measured.db, new URL("https://lxk.shoumc.com"), Promise.resolve(null));
    assert.equal(measured.metrics.queries, 4);
    assert.equal(JSON.stringify(publicData).includes("email_hash"), false);
    assert.equal(JSON.stringify(publicData).includes("author_id"), false);
    assert.equal(JSON.stringify(publicData).includes("isAdmin"), false);
  });
});

test("0007 preserves current rows/counters and AUTOINCREMENT survives all-high-ID archives and restores", async () => {
  const local = await localD1();
  try {
    const db = local.db;
    await executeScript(db, await readFile(new URL("./fixtures/schema-before-0007.sql", import.meta.url), "utf8"));
    await executeScript(
      db,
      `INSERT INTO courses VALUES ('001','Local');
      INSERT INTO course_section(lid,course_id,college,elective_type,credits) VALUES ('s1','001','c','e',1);
      INSERT INTO teachers VALUES (1,'Local');
      INSERT INTO course_reviews(id,lid,title,content,posted_at_local) VALUES (9999,'s1','Original','Content','2026-01-01');
      INSERT INTO teacher_reviews(id,teacher_id,title,content,posted_at_local) VALUES (9998,1,'Original teacher','Teacher content','2026-01-01');`,
    );
    const before = await db.prepare("SELECT * FROM site_stats").first();
    const course = await db.prepare("SELECT * FROM course_reviews").all();
    const teacher = await db.prepare("SELECT * FROM teacher_reviews").all();
    await executeScript(
      db,
      await readFile(new URL("../migrations/0007_admin_moderation.sql", import.meta.url), "utf8"),
    );
    assert.deepEqual(await db.prepare("SELECT * FROM site_stats").first(), before);
    assert.deepEqual((await db.prepare("SELECT * FROM course_reviews").all()).results, course.results);
    assert.deepEqual((await db.prepare("SELECT * FROM teacher_reviews").all()).results, teacher.results);
    const now = Math.floor(Date.now() / 1000);
    await db
      .prepare(
        "INSERT INTO auth_users(id,issuer,subject,name,created_at,last_login_at,verified_email_hash) VALUES (1,?,'admin','Admin',?,?,?)",
      )
      .bind(issuer, now, now, await auth.tokenHash(adminEmail))
      .run();
    await db
      .prepare(
        "INSERT INTO auth_sessions(token_hash,user_id,csrf_token,created_at,expires_at) VALUES (?,1,'csrf-1',?,?)",
      )
      .bind(await auth.tokenHash(token(1)), now, now + 3600)
      .run();
    for (const [kind, id] of [
      ["course", 9999],
      ["teacher", 9998],
    ]) {
      await action(db, "archiveReview", { reviewType: kind, reviewId: id, reason: "Archive all" });
      const table = kind === "course" ? "course_reviews" : "teacher_reviews";
      const reference = kind === "course" ? "lid" : "teacher_id";
      const result = await db
        .prepare(`INSERT INTO ${table}(${reference},title,content,posted_at_local) VALUES (?,'New','New','2026-01-02')`)
        .bind(kind === "course" ? "s1" : 1)
        .run();
      assert.ok(result.meta.last_row_id > id);
      await action(db, "restoreReview", { reviewType: kind, reviewId: id, reason: "Restore" });
      const next = await db
        .prepare(
          `INSERT INTO ${table}(${reference},title,content,posted_at_local) VALUES (?,'Another','Another','2026-01-03')`,
        )
        .bind(kind === "course" ? "s1" : 1)
        .run();
      assert.ok(next.meta.last_row_id > result.meta.last_row_id);
    }
    await checkCounts(db, 6);
  } finally {
    await local.close();
  }
});
