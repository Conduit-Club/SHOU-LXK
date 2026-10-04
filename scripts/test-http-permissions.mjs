// Built SSR router/layout + real Request/Response + ephemeral workerd D1.
// No remote DB, external auth/captcha request or production/browser session.
import "../tests/helpers/server-imports.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { localD1, executeScript, measureDatabase } from "../tests/helpers/local-d1.mjs";
const { tokenHash } = await import("../src/lib/server/auth.ts");
const { Server } = await import("../.svelte-kit/output/server/index.js");
const { manifest } = await import("../.svelte-kit/output/server/manifest.js");
const local = await localD1();
let checks = 0;
try {
  const db = local.db;
  await executeScript(db, await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
  const now = Math.floor(Date.now() / 1000);
  for (const [id, role] of [
    [1, "admin"],
    [2, "user"],
  ]) {
    await db
      .prepare(
        "INSERT INTO auth_users(id,issuer,subject,name,username,role,role_expires_at,created_at,last_login_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        "https://auth.shoumc.com/api/auth",
        `http-fixture-${id}`,
        `http_${id}`,
        `http_${id}`,
        role,
        now + 300,
        now,
        now,
      )
      .run();
    await db
      .prepare("INSERT INTO auth_sessions(token_hash,user_id,csrf_token,created_at,expires_at) VALUES (?,?,?,?,?)")
      .bind(await tokenHash(String(id).repeat(43)), id, `http-csrf-${id}`, now, now + 3600)
      .run();
  }
  await executeScript(
    db,
    `INSERT INTO courses VALUES ('HTTP-1','HTTP fixture course');
    INSERT INTO course_section(lid,course_id,college,elective_type,credits) VALUES ('http-section','HTTP-1','Fixture college','Fixture type',1);
    INSERT INTO teachers VALUES (1,'HTTP fixture teacher');
    INSERT INTO course_reviews(lid,title,content,posted_at_local,author_id) VALUES ('http-section','Fixture review','Fixture body','2026-01-01',2);
    INSERT INTO teacher_reviews(teacher_id,title,content,posted_at_local,author_id) VALUES (1,'Fixture review','Fixture body','2026-01-01',2);`,
  );
  const env = {
    DB: db,
    OIDC_ISSUER: "https://auth.shoumc.com/api/auth",
    OIDC_CLIENT_ID: "http-fixture",
    OIDC_CLIENT_SECRET: "synthetic-never-sent",
    OIDC_REDIRECT_URI: "https://lxk.invalid/auth/callback",
  };
  const server = new Server(manifest);
  await server.init({ env: {} });
  async function request(path, user = null, values, options = {}) {
    const url = new URL(path, "https://lxk.invalid");
    const headers = new Headers();
    headers.set("accept", options.accept ?? "text/html");
    headers.set(
      "cookie",
      `${user ? `__Host-lxk-session=${String(user).repeat(43)};` : ""} lxk-management-mode=1; isAdmin=true; roles=admin`,
    );
    if (values) {
      headers.set("origin", options.origin ?? url.origin);
      headers.set("content-type", "application/x-www-form-urlencoded");
    }
    const response = await server.respond(
      new Request(url, {
        headers,
        ...(values ? { method: "POST", body: new URLSearchParams({ csrfToken: `http-csrf-${user}`, ...values }) } : {}),
      }),
      { platform: { env }, getClientAddress: () => "127.0.0.1" },
    );
    // Kit rejects cross-site form POSTs before calling application hooks.
    // That response is fixed plaintext, never a frameable private HTML page.
    if (options.origin && options.origin !== url.origin) {
      assert.equal(response.status, 403);
      const contentType = response.headers.get("content-type");
      assert.ok(contentType === null || contentType.startsWith("text/plain"));
      assert.equal(await response.clone().text(), "Cross-site POST form submissions are forbidden");
      return response;
    }
    assert.equal(response.headers.get("content-security-policy"), "frame-ancestors 'none'", path);
    assert.equal(response.headers.get("x-frame-options"), "DENY", path);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(
      response.headers.get("referrer-policy"),
      url.pathname.startsWith("/auth/") ? "no-referrer" : "strict-origin-when-cross-origin",
      path,
    );
    return response;
  }
  for (const user of [null, 2]) {
    for (const path of ["/", "/reviews", "/courses/HTTP-1", "/teachers/1", "/submissions?kind=teacher"]) {
      const response = await request(path, user);
      assert.equal(response.status, 200, `${user ?? "guest"} GET ${path}`);
      const html = await response.text();
      assert.equal(
        /href="\/admin(?:[/?"])|action="\/admin\/mode"|管理模式：|name="reviewId"|name="userId"/.test(html),
        false,
        `management UI hidden on ${path}`,
      );
      assert.ok(response.headers.get("cache-control").includes("no-store"));
      checks++;
    }
    const status = user ? 403 : 401;
    for (const path of ["/admin", "/admin/submissions"]) {
      assert.equal((await request(path, user)).status, status, `GET ${path}`);
      checks++;
    }
    for (const [path, values] of [
      ["/admin/mode", { enabled: "1" }],
      ["/admin?/archiveReview", { reviewType: "course", reviewId: "1", reason: "forged" }],
      ["/reviews?/archiveReview", { reviewType: "course", reviewId: "1", reason: "forged" }],
      ["/courses/HTTP-1?/archiveReview", { reviewType: "course", reviewId: "1", reason: "forged" }],
      ["/teachers/1?/archiveReview", { reviewType: "teacher", reviewId: "1", reason: "forged" }],
      ["/admin/submissions?/decide", { submissionId: crypto.randomUUID(), decision: "approve", reason: "forged" }],
    ]) {
      assert.equal((await request(path, user, values)).status, status, `POST ${path}`);
      checks++;
    }
  }
  const adminHtml = await (await request("/reviews", 1)).text();
  assert.ok(adminHtml.includes('action="/admin/mode"'));
  assert.ok(adminHtml.includes('name="reviewId"'));
  checks++;
  assert.equal((await request("/admin/mode", 1, { enabled: "1", csrfToken: "forged" })).status, 403);
  checks++;
  assert.equal((await request("/admin/mode", 1, { enabled: "1" }, { origin: "https://evil.invalid" })).status, 403);
  checks++;
  await db.prepare("UPDATE auth_users SET role_expires_at=0 WHERE id=1").run();
  assert.equal((await request("/admin/submissions", 1)).status, 403);
  checks++;
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM moderation_events").first()).n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM catalog_submission_events").first()).n, 0);
  assert.equal((await db.prepare("SELECT reviews FROM site_stats WHERE id=1").first()).reviews, 2);
  const bounded = measureDatabase(db);
  env.DB = bounded.db;
  assert.equal((await request("/courses/HTTP-1?/submitReview", 2, { content: "x".repeat(64 * 1024) })).status, 413);
  assert.equal(bounded.metrics.queries, 0, "oversized POST is rejected before session or action SQL");
  env.DB = db;
  checks++;
  const previousFetch = globalThis.fetch;
  let captchaCalls = 0;
  let expireAdminDuringCaptcha = false;
  env.TURNSTILE_SECRET_KEY = "http-fixture-secret";
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.href === "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
      captchaCalls++;
      const values = new URLSearchParams(await request.text());
      assert.equal(values.get("secret"), "http-fixture-secret");
      const token = values.get("response");
      assert.ok(["http-review", "http-catalog"].includes(token));
      if (expireAdminDuringCaptcha) {
        expireAdminDuringCaptcha = false;
        await db.prepare("UPDATE auth_users SET role_expires_at=0 WHERE id=1").run();
      }
      return Response.json({
        success: true,
        hostname: "lxk.invalid",
        action: token === "http-review" ? "submit_review" : "submit_catalog",
      });
    }
    if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return previousFetch(input, init);
    throw new Error("Unexpected external fetch in a local HTTP fixture");
  };
  try {
    for (const [path, table] of [
      ["/courses/HTTP-1?/submitReview", "course_reviews"],
      ["/teachers/1?/submitReview", "teacher_reviews"],
    ]) {
      for (const visibility of ["anonymous", "username"]) {
        assert.equal(
          (
            await request(path, 2, {
              title: "HTTP publication fixture",
              content: "Only local data",
              lid: "http-section",
              visibility,
              "cf-turnstile-response": "http-review",
              author_id: "1",
              username: "forged",
              avatar: "https://evil.invalid/avatar.png",
            })
          ).status,
          303,
        );
        const review = await db
          .prepare(
            `SELECT author_id,is_anonymous,public_username,public_avatar_url FROM ${table} ORDER BY id DESC LIMIT 1`,
          )
          .first();
        assert.equal(review.author_id, 2);
        assert.equal(review.is_anonymous, visibility === "anonymous" ? 1 : 0);
        assert.equal(review.public_username, visibility === "anonymous" ? null : "http_2");
        assert.equal(review.public_avatar_url, null);
        checks++;
      }
      assert.equal(
        (
          await request(path, 2, {
            csrfToken: "forged",
            title: "Must not publish",
            content: "Denied",
            "cf-turnstile-response": "http-review",
          })
        ).status,
        403,
      );
      checks++;
    }
    const id = crypto.randomUUID();
    assert.equal(
      (
        await request("/submissions?/submit", 2, {
          kind: "teacher",
          name: "Local HTTP pending teacher",
          note: "Private proposal",
          submissionId: id,
          "cf-turnstile-response": "http-catalog",
        })
      ).status,
      303,
    );
    const proposal = await db.prepare("SELECT author_id,status FROM catalog_submissions WHERE id=?").bind(id).first();
    assert.deepEqual(proposal, { author_id: 2, status: "pending" });
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM teachers").first()).n, 1);
    const enhanced = await request(
      "/courses/HTTP-1?/submitReview",
      2,
      {
        title: "Enhanced local fixture",
        content: "Local action JSON",
        lid: "http-section",
        visibility: "anonymous",
        "cf-turnstile-response": "http-review",
      },
      { accept: "application/json" },
    );
    assert.equal(enhanced.status, 200);
    const actionRedirect = await enhanced.json();
    assert.equal(actionRedirect.type, "redirect");
    assert.equal(actionRedirect.status, 303);
    assert.equal((await db.prepare("SELECT reviews FROM site_stats WHERE id=1").first()).reviews, 7);
    assert.equal(captchaCalls, 6, "bad CSRF never reaches captcha verification");
    checks++;
    checks++;
    const direct = {
      kind: "teacher",
      name: "Local HTTP directly published teacher",
      submissionMode: "direct",
      submissionId: crypto.randomUUID(),
      "cf-turnstile-response": "http-catalog",
    };
    for (const user of [1, 2]) {
      const denied = await request("/submissions?/submit", user, direct);
      assert.equal(denied.status, 403);
      checks++;
    }
    assert.equal(captchaCalls, 6, "expired or forged direct publication is denied before captcha");
    const expiredHtml = await (await request("/submissions?kind=teacher", 1)).text();
    assert.ok(expiredHtml.includes("恢复当前表单"));
    assert.ok(expiredHtml.includes('target="_blank"'));
    assert.ok(expiredHtml.includes('name="name"'), "expired permission retains the form");
    checks++;
    await db.prepare("UPDATE auth_users SET role_expires_at=unixepoch()+3600 WHERE id=1").run();
    const directHtml = await (await request("/submissions?kind=teacher", 1)).text();
    assert.ok(directHtml.includes("直接收录并公开"));
    assert.ok(directHtml.includes('name="submissionMode" value="direct"'));
    assert.ok(directHtml.includes('href="/admin/submissions?kind=teacher"'));
    checks++;
    const published = await request("/submissions?/submit", 1, direct);
    assert.equal(published.status, 303);
    const publishedLocation = published.headers.get("location");
    assert.ok(publishedLocation.includes(`result=${direct.submissionId}`));
    const resultHtml = await (await request(publishedLocation, 1)).text();
    assert.ok(resultHtml.includes("条目已公开"));
    assert.ok(resultHtml.includes("查看已收录条目"));
    assert.deepEqual(
      await db
        .prepare("SELECT author_id,reviewed_by,status,reason FROM catalog_submissions WHERE id=?")
        .bind(direct.submissionId)
        .first(),
      { author_id: 1, reviewed_by: 1, status: "approved", reason: "管理员直接收录" },
    );
    checks++;
    assert.equal((await request("/submissions?/submit", 1, { ...direct, name: "Must not replace" })).status, 303);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM catalog_submission_events").first()).n, 1);
    checks++;
    const courseId = crypto.randomUUID();
    assert.equal(
      (
        await request("/submissions?/submit", 1, {
          ...direct,
          kind: "course",
          name: "Local HTTP maintenance course",
          courseId: "HTTP-NEW",
          college: "Fixture college",
          electiveType: "Fixture type",
          credits: "0.5",
          submissionId: courseId,
        })
      ).status,
      303,
    );
    assert.equal((await request(`/courses/HTTP-NEW?lid=community-${courseId}`, 2)).status, 200);
    assert.equal(
      (await db.prepare("SELECT credits FROM course_section WHERE course_id='HTTP-NEW'").first()).credits,
      0.5,
    );
    const filteredHalf = await request("/courses?credits=0.5", 2);
    assert.equal(filteredHalf.status, 200);
    assert.ok((await filteredHalf.text()).includes("Local HTTP maintenance course"));
    assert.equal(
      (await (await request("/courses?credits=0", 2)).text()).includes("Local HTTP maintenance course"),
      false,
    );
    checks += 2;
    checks++;
    expireAdminDuringCaptcha = true;
    const failedId = crypto.randomUUID();
    const failed = await request("/submissions?/submit", 1, {
      ...direct,
      name: "Must not become pending",
      submissionId: failedId,
    });
    assert.equal(failed.status, 403);
    const failedHtml = await failed.text();
    assert.ok(failedHtml.includes("没有保存为待审补充"));
    assert.ok(failedHtml.includes('value="Must not become pending"'));
    assert.ok(failedHtml.includes("恢复当前表单"));
    assert.equal(await db.prepare("SELECT id FROM catalog_submissions WHERE id=?").bind(failedId).first(), null);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM catalog_submission_events").first()).n, 2);
    checks++;
  } finally {
    globalThis.fetch = previousFetch;
  }
  for (const [path, user, values, status] of [
    ["/missing-security-fixture", null, undefined, 404],
    ["/auth/callback", null, undefined, 400],
    ["/auth/logout", null, { returnTo: "/reviews" }, 303],
    ["/admin/mode", 2, { enabled: "1" }, 403],
  ]) {
    assert.equal((await request(path, user, values)).status, status, path);
    checks++;
  }
  env.MAINTENANCE_MODE = "true";
  assert.equal((await request("/")).status, 503);
  assert.equal((await request("/auth/callback")).status, 503);
  checks += 2;
  env.MAINTENANCE_MODE = "false";
  env.DB = {
    prepare() {
      throw new Error("Synthetic local database failure");
    },
  };
  assert.equal((await request("/teachers")).status, 500);
  checks++;
  console.log(
    `Built SSR HTTP permission checks: ${checks} passed (guest/user/admin, forged cookie, direct endpoints, CSRF, expiry, security headers on errors/redirects/maintenance).`,
  );
} finally {
  await local.close();
}
