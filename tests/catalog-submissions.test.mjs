import "./helpers/server-imports.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { localD1, executeScript, MemoryCache } from "./helpers/local-d1.mjs";
const auth = await import("../src/lib/server/auth.ts");
const catalog = await import("../src/lib/server/catalog-submissions.ts");
const { load, actions } = await import("../src/routes/submissions/+page.server.ts");
const { load: queue, actions: adminActions } = await import("../src/routes/admin/submissions/+page.server.ts");
const { requireAdmin } = await import("../src/lib/server/moderation.ts");
const courses = await import("../src/routes/courses/[courseId]/+page.server.ts");
const teachers = await import("../src/routes/teachers/[teacherId]/+page.server.ts");
const { loadLandingData, loadCatalogPublicData } = await import("../src/lib/server/home-cache.ts");
const { load: publicCourses } = await import("../src/routes/courses/+page.server.ts");
const { load: publicTeachers } = await import("../src/routes/teachers/+page.server.ts");
const issuer = "https://auth.shoumc.com/api/auth";
const sample = {
  kind: "course",
  name: "本地课程",
  courseId: "LOCAL-201",
  college: "本地学院",
  electiveType: "本地选修",
  credits: "2",
  lid: "",
  note: "本地合成测试，非生产",
};

async function fixture(run) {
  const local = await localD1();
  try {
    const db = local.db;
    await executeScript(db, await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    const now = Math.floor(Date.now() / 1000);
    for (const [id, role] of [
      [1, "admin"],
      [2, "user"],
      [3, "user"],
    ]) {
      await db
        .prepare(
          "INSERT INTO auth_users(id,issuer,subject,name,username,role,role_expires_at,created_at,last_login_at) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .bind(id, issuer, `local-${id}`, `local_${id}`, `local_${id}`, role, now + 300, now, now)
        .run();
      await db
        .prepare("INSERT INTO auth_sessions(token_hash,user_id,csrf_token,created_at,expires_at) VALUES (?,?,?,?,?)")
        .bind(await auth.tokenHash(String(id).repeat(43)), id, `csrf-${id}`, now, now + 3600)
        .run();
    }
    await executeScript(
      db,
      `INSERT INTO courses VALUES ('001','已有课程');
      INSERT INTO course_section(lid,course_id,college,elective_type,credits) VALUES ('s1','001','学院','选修',2);
      INSERT INTO teachers VALUES (1,'已有老师');`,
    );
    await run(db);
  } finally {
    await local.close();
  }
}

class LocalForm extends FormData {
  constructor(values) {
    super();
    for (const [key, value] of Object.entries(values)) this.set(key, String(value));
  }
}

function event(db, user = 2, path = "/submissions", values, options = {}) {
  const url = new URL(path, "https://lxk.shoumc.com");
  const body = new LocalForm(values ?? {});
  body.set("csrfToken", options.csrf ?? `csrf-${user}`);
  body.set("cf-turnstile-response", "local-test-token");
  const result = {
    platform: { env: { DB: db, OIDC_ISSUER: issuer, TURNSTILE_SECRET_KEY: options.secret ?? "local-only" } },
    url,
    params: { courseId: "001", teacherId: "1" },
    request: new Request(
      url,
      values ? { method: "POST", body, headers: { Origin: options.origin ?? url.origin } } : undefined,
    ),
    cookies: {
      get: (key) =>
        key === "__Host-lxk-session" && user
          ? String(user).repeat(43)
          : key === "lxk-management-mode"
            ? "1"
            : undefined,
      delete() {},
    },
    locals: {},
    fetch: async () =>
      Response.json({
        success: options.captcha !== false,
        hostname: url.hostname,
        action: options.action ?? "submit_catalog",
      }),
  };
  let session;
  result.locals.getSession = () => (session ??= auth.readSession(result));
  return result;
}

async function submit(db, values = sample, user = 2, id = crypto.randomUUID(), options = {}) {
  let result;
  try {
    result = await actions.submit(event(db, user, "/submissions?/submit", { ...values, submissionId: id }, options));
  } catch (reason) {
    if (reason.status === 303) result = reason;
    else throw reason;
  }
  return { result, id };
}
const decide = (db, id, values = {}, user = 1, options = {}) =>
  adminActions.decide(
    event(
      db,
      user,
      "/admin/submissions?/decide",
      { ...sample, decision: "approve", reason: "本地测试核实", ...values, submissionId: id },
      options,
    ),
  );
const row = (db, id) => db.prepare("SELECT * FROM catalog_submissions WHERE id=?").bind(id).first();
const stats = (db) => db.prepare("SELECT courses,sections,reviews,teachers FROM site_stats WHERE id=1").first();

test("0009 adds empty private tables without replaying historical catalog or review data", async () => {
  const local = await localD1();
  try {
    await executeScript(
      local.db,
      await readFile(new URL("./fixtures/schema-before-0008.sql", import.meta.url), "utf8"),
    );
    await executeScript(
      local.db,
      await readFile(new URL("../migrations/0008_profiles_and_review_visibility.sql", import.meta.url), "utf8"),
    );
    await executeScript(
      local.db,
      `INSERT INTO courses VALUES ('001','原名');
      INSERT INTO course_section(lid,course_id,college,elective_type,credits) VALUES ('s1','001','原学院','原类型',1);
      INSERT INTO course_reviews(lid,title,content,posted_at_local) VALUES ('s1','原题','原文','2020-01-01');
      INSERT INTO teachers(name) VALUES ('原老师');`,
    );
    const snapshot = async () =>
      Object.fromEntries(
        await Promise.all(
          ["courses", "course_section", "teachers", "course_reviews", "site_stats"].map(async (table) => [
            table,
            (await local.db.prepare(`SELECT * FROM ${table}`).all()).results,
          ]),
        ),
      );
    const before = await snapshot();
    await executeScript(
      local.db,
      await readFile(new URL("../migrations/0009_catalog_submissions.sql", import.meta.url), "utf8"),
    );
    assert.deepEqual(await snapshot(), before);
    assert.equal((await local.db.prepare("SELECT COUNT(*) AS n FROM catalog_submissions").first()).n, 0);
    assert.deepEqual((await local.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally {
    await local.close();
  }
});

test("private queue and proposals require correct authority, profile, Origin, CSRF and catalog-specific captcha", async () => {
  await fixture(async (db) => {
    for (const [user, status] of [
      [null, 401],
      [2, 403],
    ]) {
      await assert.rejects(queue(event(db, user, "/admin/submissions")), (reason) => reason.status === status);
      await assert.rejects(decide(db, crypto.randomUUID(), {}, user), (reason) => reason.status === status);
    }
    await assert.rejects(submit(db, sample, null), (reason) => reason.status === 401);
    for (const options of [{ origin: "https://evil.invalid" }, { csrf: "forged" }]) {
      await assert.rejects(submit(db, sample, 2, undefined, options), (reason) => reason.status === 403);
      await assert.rejects(decide(db, crypto.randomUUID(), {}, 1, options), (reason) => reason.status === 403);
    }
    for (const options of [{ captcha: false }, { action: "submit_review" }, { secret: "" }]) {
      const attempt = await submit(db, sample, 2, undefined, options);
      assert.ok([400, 503].includes(attempt.result.status));
    }
    await db.prepare("UPDATE auth_users SET username=NULL WHERE id=2").run();
    await assert.rejects(submit(db), (reason) => reason.status === 401);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM catalog_submissions").first()).n, 0);
    assert.deepEqual(await stats(db), { courses: 1, sections: 1, reviews: 0, teachers: 1 });
  });
});

test("proposals stay private; owner/role/state forgery is ignored and ordinary course/teacher reviews publish immediately", async () => {
  await fixture(async (db) => {
    const teacher = await submit(db, { kind: "teacher", name: "待审老师", note: "合成" });
    const course = await submit(db, { ...sample, authorId: "1", role: "admin", status: "approved", reviewedBy: "1" });
    assert.equal(teacher.result.status, 303);
    assert.equal(course.result.status, 303);
    assert.equal((await row(db, course.id)).author_id, 2);
    assert.equal((await row(db, course.id)).status, "pending");
    assert.equal((await load(event(db, 2))).submissions.length, 2);
    assert.equal((await load(event(db, 3))).submissions.length, 0);
    assert.equal((await load(event(db, null))).submissions.length, 0);
    assert.equal((await queue(event(db, 1, "/admin/submissions?kind=teacher&q=待审"))).total, 1);
    assert.equal((await publicTeachers(event(db, null, "/teachers?q=待审"))).total, 0);
    assert.equal((await publicCourses(event(db, null, "/courses?q=LOCAL-201"))).total, 0);
    for (const [handler, path, values] of [
      [courses.actions.submitReview, "/courses/001?/submitReview", { lid: "s1" }],
      [teachers.actions.submitReview, "/teachers/1?/submitReview", {}],
    ]) {
      await assert.rejects(
        handler(
          event(
            db,
            2,
            path,
            { ...values, title: "即时公开", content: "本地合成普通用户点评", visibility: "anonymous" },
            { action: "submit_review" },
          ),
        ),
        (reason) => reason.status === 303,
      );
    }
    assert.deepEqual(await stats(db), { courses: 1, sections: 1, reviews: 2, teachers: 1 });
    assert.equal((await courses.load(event(db, null, "/courses/001"))).reviews[0].title, "即时公开");
    assert.equal((await teachers.load(event(db, null, "/teachers/1"))).reviews[0].title, "即时公开");
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM catalog_submission_events").first()).n, 0);
  });
});

test("retries/duplicates and concurrent proposals cannot bypass hourly or outstanding limits", async () => {
  await fixture(async (db) => {
    const first = await submit(db);
    assert.equal((await submit(db, { ...sample, name: "不得覆盖" }, 2, first.id)).result.status, 303);
    assert.equal((await row(db, first.id)).name, sample.name);
    assert.equal((await submit(db, sample, 3)).result.status, 409);
    assert.equal((await submit(db, { kind: "teacher", name: "已有老师" })).result.status, 409);
    assert.equal((await submit(db, { ...sample, courseId: "001" })).result.status, 409);
    assert.equal((await submit(db, { ...sample, credits: "1.5" })).result.status, 400);
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, n) => submit(db, { kind: "teacher", name: `并发老师${n}` })),
    );
    assert.equal(attempts.filter(({ result }) => result.status === 303).length, 4);
    assert.equal(attempts.filter(({ result }) => result.status === 429).length, 4);
    assert.equal((await load(event(db))).total, 5);
    const ctx = await catalog.requireSubmitter(event(db, 3));
    const same = await Promise.all(
      [1, 2].map(() =>
        catalog
          .submitCatalog(
            ctx,
            crypto.randomUUID(),
            catalog.parseCatalogDraft(new LocalForm({ kind: "teacher", name: "同一目标" })),
          )
          .catch((reason) => reason.status),
      ),
    );
    assert.equal(same.filter((result) => result === true).length, 1);
    assert.equal(same.filter((result) => result === 409).length, 1);
    for (let n = 0; n < 9; n++) {
      await db
        .prepare(
          `INSERT INTO catalog_submissions(id,author_id,kind,target_key,name,note,created_at) VALUES (?,3,'teacher',?,?, '',unixepoch()-4000)`,
        )
        .bind(crypto.randomUUID(), `teacher:old-${n}`, `旧待审${n}`)
        .run();
    }
    assert.equal((await submit(db, { kind: "teacher", name: "待审上限" }, 3)).result.status, 429);
    await assert.rejects(
      db.prepare("UPDATE catalog_submissions SET created_at=0 WHERE id=?").bind(first.id).run(),
      /LXK_SUBMISSION_(IMMUTABLE|ALREADY_REVIEWED)/,
    );
  });
});

test("approval creates a usable course/section atomically, preserves original/corrected data and clears catalog caches", async () => {
  await fixture(async (db) => {
    const cache = new MemoryCache();
    const previous = globalThis.caches;
    globalThis.caches = { open: async () => cache };
    try {
      const url = new URL("https://lxk.shoumc.com");
      await loadLandingData(db, url);
      await loadCatalogPublicData(db, url);
      const proposal = await submit(db);
      assert.equal(
        (await decide(db, proposal.id, { name: "核实后的课程", courseId: "LOCAL-202" })).message,
        "审核通过，条目已进入公开目录。",
      );
      const entry = await row(db, proposal.id);
      assert.equal(entry.name, "本地课程");
      assert.equal(entry.reason, "本地测试核实");
      assert.equal(entry.published_course_id, "LOCAL-202");
      assert.equal(entry.published_lid, `community-${proposal.id}`);
      assert.equal(JSON.parse(entry.approved_payload).name, "核实后的课程");
      const page = event(db, null, "/courses/LOCAL-202");
      page.params.courseId = "LOCAL-202";
      assert.equal((await courses.load(page)).sections.length, 1);
      assert.equal((await publicCourses(event(db, null, "/courses?q=LOCAL-202"))).total, 1);
      assert.deepEqual(await stats(db), { courses: 2, sections: 2, reviews: 0, teachers: 1 });
      assert.equal((await loadLandingData(db, url)).newCourses[0].name, "核实后的课程");
      const options = await loadCatalogPublicData(db, url);
      assert.ok(options.options.colleges.includes("本地学院"));
      assert.ok(options.options.electiveTypes.includes("本地选修"));
      const ordinary = event(
        db,
        2,
        "/courses/LOCAL-202?/submitReview",
        { lid: entry.published_lid, title: "新增课程点评", content: "立即公开" },
        { action: "submit_review" },
      );
      ordinary.params.courseId = "LOCAL-202";
      await assert.rejects(courses.actions.submitReview(ordinary), (reason) => reason.status === 303);
      assert.equal(
        (await db.prepare("SELECT review_count FROM course_section WHERE lid=?").bind(entry.published_lid).first())
          .review_count,
        1,
      );
      assert.equal((await decide(db, proposal.id)).status, 409);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM catalog_submission_events").first()).n, 1);
      await assert.rejects(
        db.prepare("UPDATE catalog_submission_events SET reason='changed'").run(),
        /AUDIT_IMMUTABLE/,
      );
      assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
    } finally {
      globalThis.caches = previous;
    }
  });
});

test("rejection gives the owner a reason and concurrent decisions publish/audit once; teacher keys use consistent ASCII folding", async () => {
  await fixture(async (db) => {
    const proposal = await submit(db, { kind: "teacher", name: "新增老师" });
    assert.equal((await decide(db, proposal.id, { decision: "reject", reason: " " })).status, 400);
    assert.equal((await row(db, proposal.id)).status, "pending");
    await decide(db, proposal.id, { decision: "reject", reason: "需核实姓名" });
    assert.equal((await load(event(db))).submissions[0].reason, "需核实姓名");
    assert.deepEqual(await stats(db), { courses: 1, sections: 1, reviews: 0, teachers: 1 });
    const corrected = await submit(db, { kind: "teacher", name: "新增老师" });
    const decisions = await Promise.all([
      decide(db, corrected.id, { name: "核实老师" }),
      decide(db, corrected.id, { decision: "reject", reason: "并发审核" }),
    ]);
    assert.equal(decisions.filter((result) => result.status === 409).length, 1);
    const approved = (await row(db, corrected.id)).status === "approved";
    assert.deepEqual(await stats(db), { courses: 1, sections: 1, reviews: 0, teachers: approved ? 2 : 1 });
    assert.equal(
      (
        await db
          .prepare("SELECT COUNT(*) AS n FROM catalog_submission_events WHERE submission_id=?")
          .bind(corrected.id)
          .first()
      ).n,
      1,
    );
    const accent = await submit(db, { kind: "teacher", name: "Émile" }, 3);
    await decide(db, accent.id, { name: "Émile" });
    assert.equal((await submit(db, { kind: "teacher", name: "ÉMILE" }, 3)).result.status, 409);
    assert.equal((await submit(db, { kind: "teacher", name: "émile" }, 3)).result.status, 303);
  });
});

test("approval rechecks central authority/collisions; insertion failure rolls back audit/state/counters", async () => {
  await fixture(async (db) => {
    const pending = await submit(db);
    const cached = await requireAdmin(event(db, 1));
    await db.prepare("UPDATE auth_users SET role_expires_at=0 WHERE id=1").run();
    const form = new LocalForm(sample);
    assert.equal(
      await catalog.decideCatalog(cached, pending.id, true, "过期权限", form, new URL("https://lxk.shoumc.com")),
      false,
    );
    assert.equal((await row(db, pending.id)).status, "pending");
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM catalog_submission_events").first()).n, 0);
    await db.prepare("UPDATE auth_users SET role_expires_at=unixepoch()+300 WHERE id=1").run();
    assert.equal((await decide(db, pending.id, { courseId: "001" })).status, 409);
    await executeScript(
      db,
      "CREATE TRIGGER local_fail_section BEFORE INSERT ON course_section BEGIN SELECT RAISE(ABORT,'local rollback test'); END;",
    );
    await assert.rejects(decide(db, pending.id), /local rollback test/);
    assert.equal((await row(db, pending.id)).status, "pending");
    assert.deepEqual(await stats(db), { courses: 1, sections: 1, reviews: 0, teachers: 1 });
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM catalog_submission_events").first()).n, 0);
    await executeScript(db, "DROP TRIGGER local_fail_section;");
    await db.prepare("UPDATE auth_users SET banned_at=unixepoch() WHERE id=1").run();
    assert.equal(
      await catalog.decideCatalog(cached, pending.id, true, "撤销会话", form, new URL("https://lxk.shoumc.com")),
      false,
    );
    const submitter = await catalog.requireSubmitter(event(db, 2));
    await db.prepare("DELETE FROM auth_sessions WHERE user_id=2").run();
    await assert.rejects(
      catalog.submitCatalog(
        submitter,
        crypto.randomUUID(),
        catalog.parseCatalogDraft(new LocalForm({ kind: "teacher", name: "撤销后不能提交" })),
      ),
      (reason) => reason.status === 401,
    );
  });
});

test("verified administrators directly publish usable catalog entries with audit, result links and cache invalidation", async () => {
  await fixture(async (db) => {
    const cache = new MemoryCache();
    const previous = globalThis.caches;
    globalThis.caches = { open: async () => cache };
    try {
      const url = new URL("https://lxk.shoumc.com");
      await loadLandingData(db, url);
      await loadCatalogPublicData(db, url);
      const teacher = await submit(db, { kind: "teacher", name: "管理员新老师", submissionMode: "direct" }, 1);
      const course = await submit(db, { ...sample, submissionMode: "pending", authorId: "2", reviewedBy: "2" }, 1);
      for (const attempt of [teacher, course]) {
        assert.equal(attempt.result.status, 303);
        assert.ok(attempt.result.location.includes(`result=${attempt.id}`));
        const entry = await row(db, attempt.id);
        assert.equal(entry.author_id, 1);
        assert.equal(entry.reviewed_by, 1);
        assert.equal(entry.status, "approved");
        assert.equal(entry.reason, "管理员直接收录");
        const resultPage = await load(event(db, 1, attempt.result.location));
        assert.equal(resultPage.canPublishDirectly, true);
        assert.equal(resultPage.resultSubmission.id, attempt.id);
        assert.equal((await load(event(db, 2, attempt.result.location))).resultSubmission, null);
      }
      const entry = await row(db, course.id);
      assert.equal(entry.published_lid, `community-${course.id}`);
      const detail = event(db, null, "/courses/LOCAL-201");
      detail.params.courseId = "LOCAL-201";
      assert.equal((await courses.load(detail)).sections.length, 1);
      assert.equal((await publicTeachers(event(db, null, "/teachers?q=管理员新老师"))).total, 1);
      assert.deepEqual(await stats(db), { courses: 2, sections: 2, reviews: 0, teachers: 2 });
      assert.equal((await loadLandingData(db, url)).newCourses[0].name, sample.name);
      assert.ok((await loadCatalogPublicData(db, url)).options.colleges.includes(sample.college));
      assert.equal((await queue(event(db, 1))).total, 0);
      assert.equal((await queue(event(db, 1, "/admin/submissions?status=approved"))).total, 2);
      const audits = (await db.prepare("SELECT actor_id,action,reason FROM catalog_submission_events").all()).results;
      assert.deepEqual(
        audits,
        Array.from({ length: 2 }, () => ({ actor_id: 1, action: "approved", reason: "管理员直接收录" })),
      );
      assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
    } finally {
      globalThis.caches = previous;
    }
  });
});

test("ordinary and expired administrators cannot forge or silently downgrade direct publication", async () => {
  await fixture(async (db) => {
    const direct = { ...sample, submissionMode: "direct" };
    const forged = await submit(db, direct, 2);
    assert.equal(forged.result.status, 403);
    assert.equal(forged.result.data.renewAdmin, false);
    await assert.rejects(submit(db, direct, null), (reason) => reason.status === 401);
    assert.equal((await load(event(db, 2))).canPublishDirectly, false);
    assert.equal((await load(event(db, null))).canPublishDirectly, false);
    await db.prepare("UPDATE auth_users SET role_expires_at=0 WHERE id=1").run();
    const expired = await submit(db, direct, 1);
    assert.equal(expired.result.status, 403);
    assert.equal(expired.result.data.renewAdmin, true);
    assert.equal((await load(event(db, 1))).adminNeedsRenewal, true);
    assert.equal((await submit(db, { ...sample, submissionMode: "pending" }, 1)).result.status, 403);
    await db.prepare("UPDATE auth_users SET role_expires_at=unixepoch()+300 WHERE id=1").run();
    const id = crypto.randomUUID();
    const request = event(db, 1, "/submissions?/submit", { ...direct, submissionId: id });
    request.fetch = async () => {
      await db.prepare("UPDATE auth_users SET role_expires_at=0 WHERE id=1").run();
      return Response.json({ success: true, hostname: request.url.hostname, action: "submit_catalog" });
    };
    const midRequest = await actions.submit(request);
    assert.equal(midRequest.status, 403);
    assert.equal(midRequest.data.renewAdmin, true);
    assert.equal(await row(db, id), null);
    assert.deepEqual(await stats(db), { courses: 1, sections: 1, reviews: 0, teachers: 1 });
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM catalog_submission_events").first()).n, 0);
    const ordinary = await submit(db, { ...sample, submissionMode: "pending" }, 2);
    assert.equal((await row(db, ordinary.id)).status, "pending");
  });
});

test("direct publication retries, UUID ownership and competing targets cannot create duplicate catalog or audit records", async () => {
  await fixture(async (db) => {
    const draft = { kind: "teacher", name: "唯一维护老师", submissionMode: "direct" };
    const id = crypto.randomUUID();
    const retries = await Promise.all([submit(db, draft, 1, id), submit(db, draft, 1, id)]);
    assert.ok(retries.every(({ result }) => result.status === 303));
    assert.equal((await submit(db, { ...draft, name: "重试不得覆盖" }, 1, id)).result.status, 303);
    assert.equal((await row(db, id)).name, draft.name);
    assert.equal((await submit(db, draft, 1)).result.status, 409);
    const pending = await submit(db, { kind: "teacher", name: "仍待审老师" }, 2);
    assert.equal((await submit(db, { kind: "teacher", name: "仍待审老师" }, 1)).result.status, 409);
    assert.equal((await submit(db, draft, 1, pending.id)).result.status, 409);
    assert.equal((await row(db, pending.id)).status, "pending");
    const targets = await Promise.all([
      submit(db, { kind: "teacher", name: "同一管理员目标" }, 1),
      submit(db, { kind: "teacher", name: "同一管理员目标" }, 1),
    ]);
    assert.equal(targets.filter(({ result }) => result.status === 303).length, 1);
    assert.equal(targets.filter(({ result }) => result.status === 409).length, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM catalog_submission_events").first()).n, 2);
    assert.deepEqual(await stats(db), { courses: 1, sections: 1, reviews: 0, teachers: 3 });
  });
});

test("direct approval with a zero-row guard or failed write rolls back the new proposal, public entries and audit", async () => {
  await fixture(async (db) => {
    const collision = await submit(db, { ...sample, lid: "s1" }, 1);
    assert.equal(collision.result.status, 409);
    assert.equal(await row(db, collision.id), null);
    await executeScript(
      db,
      `CREATE TRIGGER local_expire_direct AFTER INSERT ON catalog_submissions
      WHEN NEW.author_id=1 BEGIN UPDATE auth_users SET role_expires_at=0 WHERE id=1; END;`,
    );
    const expiredInBatch = await submit(db, sample, 1);
    assert.equal(expiredInBatch.result.status, 409);
    assert.equal(await row(db, expiredInBatch.id), null);
    assert.ok((await db.prepare("SELECT role_expires_at FROM auth_users WHERE id=1").first()).role_expires_at > 0);
    await executeScript(db, "DROP TRIGGER local_expire_direct;");
    await executeScript(
      db,
      "CREATE TRIGGER local_fail_direct BEFORE INSERT ON course_section BEGIN SELECT RAISE(ABORT,'direct rollback test'); END;",
    );
    const failedId = crypto.randomUUID();
    await assert.rejects(submit(db, sample, 1, failedId), /direct rollback test/);
    assert.equal(await row(db, failedId), null);
    assert.deepEqual(await stats(db), { courses: 1, sections: 1, reviews: 0, teachers: 1 });
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM catalog_submission_events").first()).n, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM catalog_submissions").first()).n, 0);
    assert.equal(
      (await db.prepare("SELECT COUNT(*) AS n FROM category_options WHERE value=?").bind(sample.college).first()).n,
      0,
    );
  });
});

test("administrator maintenance has an independent bounded quota and does not consume ordinary submission slots", async () => {
  await fixture(async (db) => {
    for (let n = 0; n < 60; n++) {
      assert.equal((await submit(db, { kind: "teacher", name: `维护额度${n}` }, 1)).result.status, 303);
    }
    assert.equal((await submit(db, { kind: "teacher", name: "超过每小时维护额度" }, 1)).result.status, 429);
    assert.equal(
      (await db.prepare("SELECT COUNT(*) AS n FROM catalog_submissions WHERE author_id=1 AND status='pending'").first())
        .n,
      0,
    );
    await db.prepare("UPDATE auth_users SET role='user',role_expires_at=0 WHERE id=1").run();
    for (let n = 0; n < 5; n++) {
      assert.equal((await submit(db, { kind: "teacher", name: `普通额度${n}` }, 1)).result.status, 303);
    }
    assert.equal((await submit(db, { kind: "teacher", name: "超过普通额度" }, 1)).result.status, 429);
    assert.equal(
      (await db.prepare("SELECT COUNT(*) AS n FROM catalog_submissions WHERE author_id=1 AND status='pending'").first())
        .n,
      5,
    );
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM catalog_submission_events").first()).n, 60);
  });
});
