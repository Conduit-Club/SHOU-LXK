import type { Handle, HandleServerError } from "@sveltejs/kit/hooks";
import { getBindings } from "#lib/server/platform.js";
import { readSession } from "#lib/server/auth.js";
import type { AuthSession } from "#lib/server/auth.js";
import { boundedPostRequest } from "#lib/server/request-body.js";

// Never serialize provider errors, SQL, bindings, quota details or stack traces.
export const handleError: HandleServerError = ({ kind }) => {
  console.error(JSON.stringify({ event: "request_failed", kind }));
  return { message: "加载失败，请稍后重试。" };
};

function secureResponse(response: Response, url: URL) {
  // Restrict framing only: Svelte scripts and Turnstile retain their existing
  // policy. Apply to private pages, errors, redirects and maintenance alike.
  // Multiple CSP policies apply cumulatively; keep any existing script/nonces
  // while enforcing the separate, stricter framing restriction.
  response.headers.append("Content-Security-Policy", "frame-ancestors 'none'");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set(
    "Referrer-Policy",
    url.pathname.startsWith("/auth/") ? "no-referrer" : "strict-origin-when-cross-origin",
  );
  return response;
}

// An explicit operator switch: never reopen by wall clock before the migration
// has succeeded. This runs before loaders and form actions, including data URLs.
export const handle: Handle = async ({ event, resolve }) => {
  if (getBindings(event.platform).MAINTENANCE_MODE === "true") {
    return secureResponse(
      new Response(
        `<!doctype html><html lang="zh-CN"><head>
      <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>维护中 · SHOU LXK</title><style>
      body{margin:0;min-height:100vh;display:grid;place-items:center;background:#10151b;color:#e5edf5;font-family:system-ui,sans-serif}
      main{max-width:30rem;margin:1.5rem;padding:2rem;border:1px solid #29333d;border-radius:20px;background:#171e26}
      p{line-height:1.8;color:#a9b8c7}a{color:#65b6f3}
      </style></head><body><main><p>SHOU LXK · 上海海洋大学课程评价</p>
      <h1>网站暂时维护中</h1><p>正在进行服务维护，课程查询与点评提交暂时关闭。请稍后再来。</p>
      <a href="/">重新查看</a></main></body></html>`,
        {
          status: 503,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Retry-After": "600",
            "X-Robots-Tag": "noindex",
          },
        },
      ),
      event.url,
    );
  }
  try {
    const request = await boundedPostRequest(event.request);
    if (!request) {
      return secureResponse(
        new Response("提交内容过大，请精简后重试。", {
          status: 413,
          headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
        }),
        event.url,
      );
    }
    if (request !== event.request) event = { ...event, request };
  } catch {
    return secureResponse(
      new Response("提交内容读取失败，请重新提交。", {
        status: 400,
        headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
      }),
      event.url,
    );
  }
  let session: Promise<AuthSession | null> | undefined;
  event.locals.getSession = () => (session ??= readSession(event));
  const response = await resolve(event);
  // Layouts contain the current account and CSRF token. Only the explicit
  // public JSON cache in home-cache.ts may be shared across visitors.
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.append("Vary", "Cookie");
  return secureResponse(response, event.url);
};
