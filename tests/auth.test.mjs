import "./helpers/server-imports.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { localD1, executeScript, measureDatabase } from "./helpers/local-d1.mjs";
const auth = await import("../src/lib/server/auth.ts");
const { handle } = await import("../src/hooks.server.ts");
const { load: layout } = await import("../src/routes/+layout.server.ts");
const courses = await import("../src/routes/courses/[courseId]/+page.server.ts");
const teachers = await import("../src/routes/teachers/[teacherId]/+page.server.ts");

const issuer = "https://auth.shoumc.com/api/auth";
const config = {
  OIDC_ISSUER: issuer,
  OIDC_CLIENT_ID: "local-test-client",
  OIDC_CLIENT_SECRET: "not-a-production-secret",
  OIDC_REDIRECT_URI: "https://lxk.shoumc.com/auth/callback",
};
const b64 = (value) => Buffer.from(value).toString("base64url");
const keyPair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const jwk = {
  ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)),
  kid: "local-test",
  alg: "RS256",
  use: "sig",
};

function cookieJar() {
  const values = new Map();
  const options = new Map();
  return {
    values,
    options,
    get: (name) => values.get(name),
    set: (name, value, settings) => {
      values.set(name, value);
      options.set(name, settings);
    },
    delete: (name) => values.delete(name),
  };
}

function event(db, cookies, path = "/auth/login", requestInit, env = {}) {
  const url = new URL(path, "https://lxk.shoumc.com");
  const result = {
    platform: { env: { DB: db, ...config, ...env } },
    url,
    cookies,
    request: new Request(url, requestInit),
    locals: {},
  };
  let session;
  result.locals.getSession = () => (session ??= auth.readSession(result));
  return result;
}

async function fixture(run) {
  const local = await localD1();
  try {
    await executeScript(local.db, await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    await run(local.db);
  } finally {
    await local.close();
  }
}

function provider() {
  const grants = new Map();
  let calls = 0;
  let tokenCalls = 0;
  let userInfoSubject = "subject-1";
  let userInfoData = { name: "Local student", email: "local-student@invalid.test", email_verified: true };
  return {
    get calls() {
      return calls;
    },
    get tokenCalls() {
      return tokenCalls;
    },
    set userInfoSubject(value) {
      userInfoSubject = value;
    },
    set userInfoData(value) {
      userInfoData = value;
    },
    grant(authorization, overrides = {}, corruptSignature = false) {
      const url = new URL(authorization);
      const code = `local-code-${grants.size}-${Math.random()}`;
      grants.set(code, { url, overrides, corruptSignature });
      return `/auth/callback?${new URLSearchParams({ code, state: url.searchParams.get("state") })}`;
    },
    fetch: async (address, init) => {
      calls++;
      const url = new URL(address);
      if (url.href === `${issuer}/.well-known/openid-configuration`) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/oauth2/authorize`,
          token_endpoint: `${issuer}/oauth2/token`,
          userinfo_endpoint: `${issuer}/oauth2/userinfo`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
        });
      }
      if (url.href === `${issuer}/jwks`) return Response.json({ keys: [jwk] });
      if (url.href === `${issuer}/oauth2/userinfo`)
        return Response.json({
          sub: userInfoSubject,
          ...userInfoData,
        });
      assert.equal(url.href, `${issuer}/oauth2/token`);
      tokenCalls++;
      const basic = new Headers(init.headers).get("authorization");
      assert.ok(basic?.startsWith("Basic "));
      const credentials = Buffer.from(basic.slice(6), "base64").toString("utf8").split(":");
      assert.deepEqual(credentials.map(decodeURIComponent), [config.OIDC_CLIENT_ID, config.OIDC_CLIENT_SECRET]);
      const body = new URLSearchParams(init.body);
      const grant = grants.get(body.get("code"));
      if (!grant) return Response.json({ error: "invalid_grant" }, { status: 400 });
      grants.delete(body.get("code"));
      assert.equal(body.get("redirect_uri"), config.OIDC_REDIRECT_URI);
      assert.equal(
        b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.get("code_verifier")))),
        grant.url.searchParams.get("code_challenge"),
      );
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: issuer,
        aud: config.OIDC_CLIENT_ID,
        sub: "subject-1",
        iat: now,
        exp: now + 600,
        nonce: grant.url.searchParams.get("nonce"),
        email_verified: true,
        email: "local-student@invalid.test",
        name: "Local student",
        ...grant.overrides,
      };
      const unsigned = `${b64(JSON.stringify({ alg: "RS256", kid: "local-test" }))}.${b64(JSON.stringify(claims))}`;
      let signature = b64(
        await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(unsigned)),
      );
      if (grant.corruptSignature) signature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
      return Response.json({
        access_token: "test-access-token-never-stored",
        token_type: "Bearer",
        expires_in: 600,
        id_token: `${unsigned}.${signature}`,
      });
    },
  };
}

test("return destinations cannot escape the site before or after URL normalization", () => {
  for (const value of [
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "/%5Cevil.test",
    "/%2F%2Fevil.test",
    "/a/..//evil.test",
    "/%2e%2e//evil.test",
    "/auth/login",
    "/auth/callback?code=secret",
    "/a\nlocation:evil",
    "not/a/path",
  ]) {
    assert.equal(auth.safeReturnTo(value), "/", value);
  }
  assert.equal(
    auth.safeReturnTo("/courses/001?lid=1&write=1#review-composer"),
    "/courses/001?lid=1&write=1#review-composer",
  );
});

test("OIDC transaction binds browser, PKCE, state and nonce; sessions persist as opaque hashes and revoke on logout", async () => {
  await fixture(async (db) => {
    const jar = cookieJar();
    const mock = provider();
    const target = "/courses/001?lid=1&write=1";
    const start = event(db, jar, `/auth/register?${new URLSearchParams({ returnTo: target })}`);
    const authorization = await auth.beginLogin(start, true, mock.fetch);
    const authorize = new URL(authorization);
    assert.equal(authorize.searchParams.get("prompt"), "create");
    assert.equal(authorize.searchParams.get("scope"), "openid profile email");
    assert.equal(authorize.searchParams.has("client_secret"), false);
    assert.deepEqual(jar.options.get("__Host-lxk-login"), {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: auth.LOGIN_TTL,
    });
    const callbackPath = mock.grant(authorization);
    const attacker = cookieJar();
    attacker.set("__Host-lxk-login", "x".repeat(43), {});
    await assert.rejects(auth.completeLogin(event(db, attacker, callbackPath), mock.fetch));
    assert.equal(mock.tokenCalls, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM auth_login_transactions").first()).count, 1);
    assert.equal(await auth.completeLogin(event(db, jar, callbackPath), mock.fetch), target);
    assert.equal(jar.values.has("__Host-lxk-login"), false);
    const rawToken = jar.get("__Host-lxk-session");
    assert.match(rawToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(jar.options.get("__Host-lxk-session").maxAge, auth.SESSION_TTL);
    const stored = await db.prepare("SELECT * FROM auth_sessions").first();
    assert.equal(stored.token_hash, await auth.tokenHash(rawToken));
    assert.equal(stored.expires_at - stored.created_at, auth.SESSION_TTL);
    assert.equal(JSON.stringify(stored).includes(rawToken), false);
    assert.equal(JSON.stringify(stored).includes("test-access-token"), false);
    const session = await auth.readSession(event(db, jar, "/"));
    assert.equal(session.userId, 1);
    assert.equal(session.name, "Local student");
    await assert.rejects(auth.completeLogin(event(db, jar, callbackPath), mock.fetch));
    assert.equal(mock.tokenCalls, 1);
    for (const [origin, csrf] of [
      ["https://evil.test", session.csrfToken],
      ["https://lxk.shoumc.com", "wrong"],
    ]) {
      const form = new FormData();
      form.set("csrfToken", csrf);
      await assert.rejects(
        auth.endSession(event(db, jar, "/auth/logout", { method: "POST", body: form, headers: { Origin: origin } })),
      );
      assert.ok(await auth.readSession(event(db, jar, "/")));
    }
    const form = new FormData();
    form.set("csrfToken", session.csrfToken);
    form.set("returnTo", target);
    assert.equal(
      await auth.endSession(
        event(db, jar, "/auth/logout", { method: "POST", body: form, headers: { Origin: "https://lxk.shoumc.com" } }),
      ),
      target,
    );
    assert.equal(await auth.readSession(event(db, jar, "/")), null);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM auth_sessions").first()).count, 0);
  });
});

test("invalid signature, issuer, audience, nonce, expiry, unverified identity and expired transaction fail closed", async () => {
  await fixture(async (db) => {
    for (const [overrides, corrupt] of [
      [{}, true],
      [{ iss: "https://evil.test" }, false],
      [{ aud: "other-client" }, false],
      [{ nonce: "wrong" }, false],
      [{ exp: 1 }, false],
      [{ email_verified: false }, false],
      [{ sub: "" }, false],
    ]) {
      const jar = cookieJar();
      const mock = provider();
      const authorization = await auth.beginLogin(event(db, jar), false, mock.fetch);
      const callbackPath = mock.grant(authorization, overrides, corrupt);
      await assert.rejects(auth.completeLogin(event(db, jar, callbackPath), mock.fetch));
      assert.equal(jar.values.has("__Host-lxk-session"), false);
      assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM auth_login_transactions").first()).count, 0);
      await assert.rejects(auth.completeLogin(event(db, jar, callbackPath), mock.fetch));
      assert.equal(mock.tokenCalls, 1);
    }
    const jar = cookieJar();
    const mock = provider();
    const authorization = await auth.beginLogin(event(db, jar), false, mock.fetch);
    await db.prepare("UPDATE auth_login_transactions SET created_at=1, expires_at=2").run();
    await assert.rejects(auth.completeLogin(event(db, jar, mock.grant(authorization)), mock.fetch));
    assert.equal(mock.tokenCalls, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM auth_users").first()).count, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM auth_sessions").first()).count, 0);
  });
});

test("userinfo fallback checks the ID Token subject and issuer+sub remains the identity key", async () => {
  await fixture(async (db) => {
    const jar = cookieJar();
    const mock = provider();
    const authorization = await auth.beginLogin(event(db, jar), false, mock.fetch);
    await auth.completeLogin(
      event(db, jar, mock.grant(authorization, { email_verified: undefined, name: undefined })),
      mock.fetch,
    );
    const next = await auth.beginLogin(event(db, jar), false, mock.fetch);
    await auth.completeLogin(
      event(db, jar, mock.grant(next, { name: "Updated name", email: "changed@invalid.test" })),
      mock.fetch,
    );
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM auth_users").first()).count, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM auth_sessions").first()).count, 1);
    assert.equal((await auth.readSession(event(db, jar, "/"))).name, "Updated name");
    const mismatch = await auth.beginLogin(event(db, jar), false, mock.fetch);
    mock.userInfoSubject = "other-user";
    await assert.rejects(
      auth.completeLogin(event(db, jar, mock.grant(mismatch, { email_verified: undefined })), mock.fetch),
    );
    const sessions = await db.prepare("SELECT * FROM auth_sessions").all();
    await db.prepare("UPDATE auth_sessions SET created_at=1, expires_at=2").run();
    assert.equal(await auth.readSession(event(db, jar, "/")), null);
    assert.equal(sessions.results.length, 1);
  });
});

test("administrator binding uses a complete verified email pair and cannot come from query or name claims", async () => {
  await fixture(async (db) => {
    const mailbox = "admin@invalid.test";
    const jar = cookieJar();
    const mock = provider();
    const env = { LXK_ADMIN_EMAILS: mailbox };
    const login = async (overrides, userInfo) => {
      if (userInfo) mock.userInfoData = userInfo;
      const authorization = await auth.beginLogin(
        event(db, jar, "/auth/login?email=admin%40invalid.test&isAdmin=true", undefined, env),
        false,
        mock.fetch,
      );
      await auth.completeLogin(event(db, jar, mock.grant(authorization, overrides)), mock.fetch);
      return auth.readSession(event(db, jar, "/", undefined, env));
    };
    assert.equal((await login({ name: mailbox })).isAdmin, false);
    // Mixing an unverified ID Token email and UserInfo's unrelated verified
    // flag would grant admin. Only a complete pair from one source is trusted.
    assert.equal((await login({ email: mailbox, email_verified: undefined })).isAdmin, false);
    const trusted = await login({ email: " Admin@Invalid.Test ", email_verified: true });
    assert.equal(trusted.isAdmin, true);
    const row = await db.prepare("SELECT * FROM auth_users").first();
    assert.equal(row.verified_email_hash, await auth.tokenHash(mailbox));
    assert.equal(Object.hasOwn(row, "email"), false);
    const privateLayout = await layout(event(db, jar, "/", undefined, env));
    assert.equal(privateLayout.auth.isAdmin, true);
    assert.equal(JSON.stringify(privateLayout).includes(row.verified_email_hash), false);
    assert.equal((await auth.readSession(event(db, jar, "/", undefined, { LXK_ADMIN_EMAILS: "" }))).isAdmin, false);
    await db
      .prepare("UPDATE auth_users SET banned_at=? WHERE id=?")
      .bind(Math.floor(Date.now() / 1000), trusted.userId)
      .run();
    assert.equal(await auth.readSession(event(db, jar, "/", undefined, env)), null);
    const authorization = await auth.beginLogin(event(db, jar, "/auth/login", undefined, env), false, mock.fetch);
    await assert.rejects(
      auth.completeLogin(event(db, jar, mock.grant(authorization, { email: mailbox })), mock.fetch),
      (reason) => reason.status === 403,
    );
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM auth_sessions").first()).n, 0);
    assert.notEqual((await db.prepare("SELECT banned_at FROM auth_users").first()).banned_at, null);
  });
});

test("public anonymous requests execute no auth SQL and all personalized responses forbid shared caching", async () => {
  const noDb = {
    ...config,
    get DB() {
      throw new Error("Anonymous authentication must not query D1");
    },
  };
  const actual = event(null, cookieJar(), "/");
  actual.platform.env = noDb;
  const response = await handle({ event: actual, resolve: async (request) => Response.json(await layout(request)) });
  const data = await response.json();
  assert.equal(data.auth, null);
  assert.equal(data.authEnabled, true);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.match(response.headers.get("vary"), /Cookie/);
  await fixture(async (db) => {
    const jar = cookieJar();
    const mock = provider();
    const authorization = await auth.beginLogin(event(db, jar), false, mock.fetch);
    await auth.completeLogin(event(db, jar, mock.grant(authorization)), mock.fetch);
    const measured = measureDatabase(db);
    const authenticated = event(measured.db, jar, "/courses");
    const privateResponse = await handle({
      event: authenticated,
      resolve: async (request) => {
        const first = await layout(request);
        assert.deepEqual(await layout(request), first);
        return Response.json(first);
      },
    });
    assert.equal(measured.metrics.queries, 1);
    assert.ok((await privateResponse.json()).auth.csrfToken);
    assert.equal(privateResponse.headers.get("cache-control"), "private, no-store");
  });
});

test("missing secrets and insecure production configuration cannot create authentication transactions", async () => {
  const unused = {
    prepare() {
      throw new Error("Must fail before D1");
    },
  };
  const mock = provider();
  for (const env of [
    { OIDC_CLIENT_SECRET: undefined },
    { OIDC_REDIRECT_URI: "http://lxk.shoumc.com/auth/callback" },
    { OIDC_ISSUER: "http://auth.shoumc.com/api/auth", OIDC_ALLOW_LOCAL_HTTP: "true" },
    { OIDC_REDIRECT_URI: "https://lxk.shoumc.com/auth/callback?extra=x" },
  ]) {
    await assert.rejects(auth.beginLogin(event(unused, cookieJar(), "/auth/login", undefined, env), false, mock.fetch));
  }
  assert.equal(mock.calls, 0);
});

test("login and register route handlers permit the validated provider redirect and hide configuration failures", async () => {
  const { GET: login } = await import("../src/routes/auth/login/+server.ts");
  const { GET: register } = await import("../src/routes/auth/register/+server.ts");
  const originalFetch = globalThis.fetch;
  const mock = provider();
  globalThis.fetch = mock.fetch;
  try {
    await fixture(async (db) => {
      for (const [route, path, intent] of [
        [login, "/auth/login?returnTo=%2Fcourses%2F001", null],
        [register, "/auth/register?returnTo=%2Fteachers%2F1", "create"],
      ]) {
        await assert.rejects(route(event(db, cookieJar(), path)), (redirect) => {
          assert.equal(redirect.status, 303);
          const destination = new URL(redirect.location);
          assert.equal(destination.origin, "https://auth.shoumc.com");
          assert.equal(destination.pathname, "/api/auth/oauth2/authorize");
          assert.equal(destination.searchParams.get("prompt"), intent);
          assert.equal(destination.searchParams.get("code_challenge_method"), "S256");
          assert.equal(destination.searchParams.has("client_secret"), false);
          return true;
        });
      }
      await assert.rejects(
        login(event(db, cookieJar(), "/auth/login", undefined, { OIDC_CLIENT_SECRET: undefined })),
        (failure) => {
          assert.equal(failure.status, 503);
          assert.equal(failure.body.message, "账号服务暂时不可用，请稍后重试。");
          return true;
        },
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("both review actions reject visitors, bad CSRF and bad Origin before Turnstile or a write", async () => {
  await fixture(async (db) => {
    await executeScript(
      db,
      `INSERT INTO courses VALUES ('001','Local');
      INSERT INTO course_section(lid,course_id,college,elective_type,credits) VALUES ('1','001','c','e',1);
      INSERT INTO teachers VALUES (1,'Local teacher');`,
    );
    for (const [module, path] of [
      [courses, "/courses/001?/submitReview"],
      [teachers, "/teachers/1?/submitReview"],
    ]) {
      for (const [session, origin, csrf, status] of [
        [null, "https://lxk.shoumc.com", "a", 401],
        [{ userId: 1, csrfToken: "secret" }, "https://evil.test", "secret", 403],
        [{ userId: 1, csrfToken: "secret" }, "https://lxk.shoumc.com", "wrong", 403],
      ]) {
        const form = new FormData();
        form.set("csrfToken", csrf);
        form.set("title", "Title");
        form.set("content", "Body");
        form.set("lid", "1");
        const request = event(db, cookieJar(), path, { method: "POST", body: form, headers: { Origin: origin } });
        request.params = { courseId: "001", teacherId: "1" };
        request.locals.getSession = async () => session;
        request.fetch = async () => {
          throw new Error("Must reject before Turnstile");
        };
        await assert.rejects(module.actions.submitReview(request), (error) => error.status === status);
      }
    }
    assert.equal((await db.prepare("SELECT reviews FROM site_stats WHERE id=1").first()).reviews, 0);
  });
});

test("0006 and 0007 preserve legacy review IDs/content/counters and create the same columns as a fresh schema", async () => {
  const local = await localD1();
  const fresh = await localD1();
  try {
    const db = local.db;
    await executeScript(db, await readFile(new URL("./fixtures/schema-before-0006.sql", import.meta.url), "utf8"));
    await executeScript(
      db,
      `INSERT INTO courses VALUES ('001','Local');
      INSERT INTO course_section(lid,course_id,college,elective_type,credits) VALUES ('1','001','c','e',1);
      INSERT INTO teachers VALUES (1,'Local teacher');
      INSERT INTO course_reviews VALUES (123,'1','Legacy','Original content','2026-01-01');
      INSERT INTO teacher_reviews VALUES (234,1,'Legacy teacher','Original teacher content','2026-01-01');`,
    );
    const before = await db.prepare("SELECT * FROM site_stats").first();
    await executeScript(db, await readFile(new URL("../migrations/0006_unified_auth.sql", import.meta.url), "utf8"));
    await executeScript(
      db,
      await readFile(new URL("../migrations/0007_admin_moderation.sql", import.meta.url), "utf8"),
    );
    assert.deepEqual(await db.prepare("SELECT * FROM site_stats").first(), before);
    assert.equal((await db.prepare("SELECT id, content, author_id FROM course_reviews").first()).author_id, null);
    assert.equal((await db.prepare("SELECT id, content, author_id FROM teacher_reviews").first()).author_id, null);
    assert.equal((await db.prepare("SELECT review_count FROM course_section").first()).review_count, 1);
    await executeScript(fresh.db, await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    for (const table of [
      "auth_users",
      "auth_sessions",
      "auth_login_transactions",
      "course_reviews",
      "teacher_reviews",
    ]) {
      assert.deepEqual(
        (await db.prepare(`PRAGMA table_info(${table})`).all()).results,
        (await fresh.db.prepare(`PRAGMA table_info(${table})`).all()).results,
      );
    }
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally {
    await local.close();
    await fresh.close();
  }
});
