import { authConfigured, requestSession } from "#lib/server/auth.js";
import { getBindings } from "#lib/server/platform.js";
import { MANAGEMENT_COOKIE } from "#lib/server/moderation.js";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async (event) => {
  const session = await requestSession(event);
  return {
    auth: session
      ? {
          name: session.name,
          username: session.username,
          avatarUrl: session.avatarUrl,
          csrfToken: session.csrfToken,
          expiresAt: session.expiresAt,
          isAdmin: session.isAdmin,
          canRenewAdmin: session.canRenewAdmin,
          adminExpiresAt: session.adminExpiresAt,
        }
      : null,
    managementMode: !!session?.isAdmin && event.cookies.get(MANAGEMENT_COOKIE) === "1",
    authEnabled: authConfigured(getBindings(event.platform), event.url),
  };
};
