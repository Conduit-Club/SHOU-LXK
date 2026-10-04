import { authConfigured, requestSession } from "#lib/server/auth.js";
import { getBindings } from "#lib/server/platform.js";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async (event) => {
  const session = await requestSession(event);
  return {
    auth: session
      ? { name: session.name, csrfToken: session.csrfToken, expiresAt: session.expiresAt, isAdmin: session.isAdmin }
      : null,
    authEnabled: authConfigured(getBindings(event.platform), event.url),
  };
};
