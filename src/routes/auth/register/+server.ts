import { authError, beginLogin, safeReturnTo } from "#lib/server/auth.js";
import { handleAuthEntry } from "#lib/server/auth-entry.js";
import { getBindings } from "#lib/server/platform.js";
import type { RequestHandler } from "./$types";

const entry: RequestHandler = async (event) => {
  const env = getBindings(event.platform);
  try {
    return await handleAuthEntry(
      event.request,
      {
        siteKey: env.TURNSTILE_SITE_KEY,
        secret: env.TURNSTILE_SECRET_KEY,
        ipLimiter: env.AUTH_IP_LIMITER,
        siteLimiter: env.AUTH_SITE_LIMITER,
        returnTo: safeReturnTo(event.url.searchParams.get("returnTo")),
        brand: "SHOU LXK · 上海海洋大学课程评价",
      },
      () => beginLogin(event, true),
    );
  } catch (reason) {
    authError(reason);
  }
};
export const GET = entry;
export const POST = entry;
