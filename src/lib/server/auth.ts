import * as oidc from "openid-client";
import { error } from "@sveltejs/kit";
import type { Cookies, RequestEvent } from "@sveltejs/kit";
import { getBindings } from "./platform.js";

export const SESSION_TTL = 8 * 60 * 60;
export const LOGIN_TTL = 10 * 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const loopback = (host: string) => ["localhost", "127.0.0.1", "[::1]"].includes(host);
const seconds = () => Math.floor(Date.now() / 1000);

export type AuthSession = {
  userId: number;
  name: string;
  csrfToken: string;
  expiresAt: number;
};
type AuthEvent = Pick<RequestEvent, "platform" | "url" | "cookies" | "locals" | "request">;
type Bindings = App.Platform["env"];
type Settings = { issuer: URL; clientId: string; secret: string; callback: URL; localHttp: boolean };

class AuthFailure extends Error {
  status: 400 | 503;
  constructor(status: 400 | 503) {
    super("Authentication failed");
    this.status = status;
  }
}

function settings(env: Bindings): Settings {
  try {
    if (!env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET || !env.OIDC_REDIRECT_URI) throw new Error();
    const issuer = new URL(env.OIDC_ISSUER ?? "https://auth.shoumc.com/api/auth");
    const callback = new URL(env.OIDC_REDIRECT_URI);
    const localHttp = env.OIDC_ALLOW_LOCAL_HTTP === "true" && loopback(issuer.hostname) && loopback(callback.hostname);
    for (const address of [issuer, callback]) {
      if (address.username || address.password || address.search || address.hash) throw new Error();
      if (address.protocol !== "https:" && !(localHttp && address.protocol === "http:")) throw new Error();
    }
    if (callback.pathname !== "/auth/callback") throw new Error();
    return { issuer, callback, clientId: env.OIDC_CLIENT_ID, secret: env.OIDC_CLIENT_SECRET, localHttp };
  } catch {
    throw new AuthFailure(503);
  }
}

export function authConfigured(env: Bindings, url: URL): boolean {
  try {
    return settings(env).callback.origin === url.origin;
  } catch {
    return false;
  }
}

function requestSettings(event: AuthEvent) {
  const env = getBindings(event.platform);
  const config = settings(env);
  if (config.callback.origin !== event.url.origin || !env.DB) throw new AuthFailure(503);
  return { env, config, db: env.DB };
}

// Only provider configuration is cached. No user, login transaction or token is
// kept in isolate memory; all request state is persisted in this site's D1.
let providerCache: { key: string; expiresAt: number; promise: Promise<oidc.Configuration> } | undefined;

export async function discoverProvider(env: Bindings, fetcher?: oidc.CustomFetch) {
  const config = settings(env);
  const key = `${config.issuer.href}\n${config.clientId}\n${config.secret}\n${config.callback.href}`;
  if (!fetcher && providerCache?.key === key && providerCache.expiresAt > seconds()) return providerCache.promise;
  const promise = oidc.discovery(
    config.issuer,
    config.clientId,
    { client_secret: config.secret, redirect_uris: [config.callback.href] },
    oidc.ClientSecretBasic(config.secret),
    {
      timeout: 10,
      execute: [oidc.enableNonRepudiationChecks, ...(config.localHttp ? [oidc.allowInsecureRequests] : [])],
      ...(fetcher ? { [oidc.customFetch]: fetcher } : {}),
    },
  );
  if (!fetcher) {
    providerCache = { key, expiresAt: seconds() + LOGIN_TTL, promise };
    promise.catch(() => {
      if (providerCache?.promise === promise) providerCache = undefined;
    });
  }
  return promise;
}

export function safeReturnTo(value: string | null | undefined): string {
  const unsafe = (text: string) =>
    Array.from(text).some((char) => char === "\\" || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  if (!value || value.length > 2000 || !value.startsWith("/") || value.startsWith("//") || unsafe(value)) {
    return "/";
  }
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith("//") || unsafe(decoded)) return "/";
    const destination = new URL(value, "https://lxk.invalid");
    if (
      destination.origin !== "https://lxk.invalid" ||
      destination.pathname.startsWith("//") ||
      /^\/auth(?:\/|$)/.test(destination.pathname)
    )
      return "/";
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return "/";
  }
}

export const tokenHash = async (token: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

function cookieName(url: URL, type: "session" | "login") {
  return url.protocol === "https:" ? `__Host-lxk-${type}` : `lxk-dev-${type}`;
}
function setCookie(cookies: Cookies, url: URL, type: "session" | "login", token: string, maxAge: number) {
  cookies.set(cookieName(url, type), token, {
    path: "/",
    httpOnly: true,
    secure: url.protocol === "https:",
    sameSite: "lax",
    maxAge,
  });
}
function clearCookie(cookies: Cookies, url: URL, type: "session" | "login") {
  cookies.delete(cookieName(url, type), {
    path: "/",
    httpOnly: true,
    secure: url.protocol === "https:",
    sameSite: "lax",
  });
}

export async function readSession(event: Pick<AuthEvent, "platform" | "url" | "cookies">): Promise<AuthSession | null> {
  const token = event.cookies.get(cookieName(event.url, "session"));
  // Anonymous requests do not even obtain the database binding or execute SQL.
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  const env = getBindings(event.platform);
  if (event.url.protocol !== "https:" && !(env.OIDC_ALLOW_LOCAL_HTTP === "true" && loopback(event.url.hostname)))
    return null;
  if (!env.DB) return null;
  const record =
    await env.DB.prepare(`SELECT u.id AS userId, u.name, s.csrf_token AS csrfToken, s.expires_at AS expiresAt
      FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`)
      .bind(await tokenHash(token), seconds())
      .first<AuthSession>();
  if (!record) clearCookie(event.cookies, event.url, "session");
  return record;
}

export function requestSession(event: AuthEvent): Promise<AuthSession | null> {
  return event.locals.getSession();
}

export function sameOriginPost(request: Request, url: URL): boolean {
  return request.method === "POST" && request.headers.get("origin") === url.origin;
}

export async function reviewSession(event: AuthEvent, form: FormData): Promise<AuthSession> {
  const session = await requestSession(event);
  if (!session) error(401, "请先登录后再发表点评。");
  if (!sameOriginPost(event.request, event.url) || form.get("csrfToken") !== session.csrfToken) {
    error(403, "请求已失效，请刷新页面后重试。");
  }
  return session;
}

async function pruneExpired(db: D1Database) {
  // Bound cleanup work; expiry is enforced on every read even before removal.
  await db.batch([
    db
      .prepare(`DELETE FROM auth_login_transactions WHERE state_hash IN
      (SELECT state_hash FROM auth_login_transactions WHERE expires_at <= ? ORDER BY expires_at LIMIT 50)`)
      .bind(seconds()),
    db
      .prepare(`DELETE FROM auth_sessions WHERE token_hash IN
      (SELECT token_hash FROM auth_sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT 50)`)
      .bind(seconds()),
  ]);
}

export async function beginLogin(event: AuthEvent, register = false, fetcher?: oidc.CustomFetch): Promise<string> {
  const { env, config, db } = requestSettings(event);
  const provider = await discoverProvider(env, fetcher);
  const state = oidc.randomState();
  const browserToken = oidc.randomState();
  const verifier = oidc.randomPKCECodeVerifier();
  const nonce = oidc.randomNonce();
  const returnTo = safeReturnTo(event.url.searchParams.get("returnTo"));
  const authorization = oidc.buildAuthorizationUrl(provider, {
    redirect_uri: config.callback.href,
    response_type: "code",
    scope: "openid profile email",
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state,
    nonce,
    ...(register ? { prompt: "create" } : {}),
  });
  await pruneExpired(db);
  await db
    .prepare(`INSERT INTO auth_login_transactions
      (state_hash, browser_hash, verifier, nonce, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      await tokenHash(state),
      await tokenHash(browserToken),
      verifier,
      nonce,
      returnTo,
      seconds(),
      seconds() + LOGIN_TTL,
    )
    .run();
  setCookie(event.cookies, event.url, "login", browserToken, LOGIN_TTL);
  return authorization.href;
}

type LoginTransaction = { verifier: string; nonce: string; return_to: string };

export async function completeLogin(event: AuthEvent, fetcher?: oidc.CustomFetch): Promise<string> {
  const { env, config, db } = requestSettings(event);
  const state = event.url.searchParams.get("state");
  const browserToken = event.cookies.get(cookieName(event.url, "login"));
  if (!state || !TOKEN_PATTERN.test(state) || !browserToken || !TOKEN_PATTERN.test(browserToken))
    throw new AuthFailure(400);
  if (event.url.pathname !== config.callback.pathname || event.url.searchParams.getAll("state").length !== 1)
    throw new AuthFailure(400);
  // DELETE...RETURNING is atomic: retries, concurrent callbacks and stolen
  // callback URLs cannot consume another browser's transaction or use it twice.
  const transaction = await db
    .prepare(`DELETE FROM auth_login_transactions WHERE state_hash = ? AND browser_hash = ? AND expires_at > ?
      RETURNING verifier, nonce, return_to`)
    .bind(await tokenHash(state), await tokenHash(browserToken), seconds())
    .first<LoginTransaction>();
  if (!transaction) throw new AuthFailure(400);
  clearCookie(event.cookies, event.url, "login");
  const provider = await discoverProvider(env, fetcher);
  const tokens = await oidc.authorizationCodeGrant(provider, event.url, {
    pkceCodeVerifier: transaction.verifier,
    expectedState: state,
    expectedNonce: transaction.nonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims || !claims.sub || claims.sub.length > 255) throw new AuthFailure(400);
  const userInfo =
    claims.email_verified === undefined
      ? await oidc.fetchUserInfo(provider, tokens.access_token, claims.sub)
      : undefined;
  if ((claims.email_verified ?? userInfo?.email_verified) !== true) throw new AuthFailure(400);
  const rawName = claims.name ?? userInfo?.name;
  const name = typeof rawName === "string" && rawName.trim() ? rawName.trim().slice(0, 160) : "海大同学";
  const user = await db
    .prepare(`INSERT INTO auth_users (issuer, subject, name, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (issuer, subject) DO UPDATE SET name = excluded.name, last_login_at = excluded.last_login_at RETURNING id`)
    .bind(config.issuer.href, claims.sub, name, seconds(), seconds())
    .first<{ id: number }>();
  if (!user) throw new AuthFailure(503);
  const token = oidc.randomState();
  const oldToken = event.cookies.get(cookieName(event.url, "session"));
  const statements = [
    db
      .prepare(
        `INSERT INTO auth_sessions (token_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(await tokenHash(token), user.id, oidc.randomState(), seconds(), seconds() + SESSION_TTL),
  ];
  if (oldToken && TOKEN_PATTERN.test(oldToken)) {
    statements.push(db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await tokenHash(oldToken)));
  }
  await db.batch(statements);
  setCookie(event.cookies, event.url, "session", token, SESSION_TTL);
  return safeReturnTo(transaction.return_to);
}

export async function endSession(event: AuthEvent): Promise<string> {
  if (!sameOriginPost(event.request, event.url)) throw new AuthFailure(400);
  const form = await event.request.formData();
  const session = await requestSession(event);
  if (session) {
    if (form.get("csrfToken") !== session.csrfToken) throw new AuthFailure(400);
    const token = event.cookies.get(cookieName(event.url, "session"));
    if (!token) throw new AuthFailure(400);
    await getBindings(event.platform)
      .DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?")
      .bind(await tokenHash(token))
      .run();
  }
  clearCookie(event.cookies, event.url, "session");
  return safeReturnTo(typeof form.get("returnTo") === "string" ? (form.get("returnTo") as string) : "/");
}

export function authError(reason: unknown): never {
  // Never log codes, tokens, email addresses, query strings or provider errors.
  const status = reason instanceof AuthFailure ? reason.status : 503;
  console.warn(JSON.stringify({ event: "auth_failed", status }));
  error(status, status === 400 ? "登录请求已失效，请重新登录。" : "账号服务暂时不可用，请稍后重试。");
}
