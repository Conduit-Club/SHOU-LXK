// Built SSR router/layout + real Request/Response + ephemeral workerd D1.
// No remote DB, external auth/captcha request or production/browser session.
import "../tests/helpers/server-imports.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { localD1, executeScript } from "../tests/helpers/local-d1.mjs";
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
    headers.set(
      "cookie",
      `${user ? `__Host-lxk-session=${String(user).repeat(43)};` : ""} lxk-management-mode=1; isAdmin=true; roles=admin`,
    );
    if (values) {
      headers.set("origin", options.origin ?? url.origin);
      headers.set("content-type", "application/x-www-form-urlencoded");
    }
    return server.respond(
      new Request(url, {
        headers,
        ...(values ? { method: "POST", body: new URLSearchParams({ csrfToken: `http-csrf-${user}`, ...values }) } : {}),
      }),
      { platform: { env }, getClientAddress: () => "127.0.0.1" },
    );
  }
  for (const user of [null, 2]) {
    for (const path of ["/", "/reviews", "/courses/HTTP-1", "/teachers/1", "/submissions?kind=teacher"]) {
      const response = await request(path, user);
      assert.equal(response.status, 200, `${user ?? "guest"} GET ${path}`);
      const html = await response.text();
      assert.equal(
        /href="\/admin(?:\?|")|action="\/admin\/mode"|管理模式：|name="reviewId"|name="userId"/.test(html),
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
  console.log(
    `Built SSR HTTP permission checks: ${checks} passed (guest/user/admin, forged cookie, direct endpoints, CSRF, expiry).`,
  );
} finally {
  await local.close();
}
