/// <reference types="@cloudflare/workers-types" />

declare global {
  namespace App {
    interface Locals {
      getSession: () => Promise<import("./lib/server/auth.js").AuthSession | null>;
    }
    interface PageState {
      detailFromApp?: boolean;
    }

    interface Platform {
      env: {
        DB: D1Database;
        AUTH_IP_LIMITER?: import("./lib/server/auth-entry.js").LoginLimiter;
        AUTH_SITE_LIMITER?: import("./lib/server/auth-entry.js").LoginLimiter;
        MAINTENANCE_MODE?: string;
        TURNSTILE_SITE_KEY?: string;
        TURNSTILE_SECRET_KEY?: string;
        OIDC_ISSUER?: string;
        OIDC_CLIENT_ID?: string;
        OIDC_CLIENT_SECRET?: string;
        OIDC_REDIRECT_URI?: string;
        OIDC_ALLOW_LOCAL_HTTP?: string;
      };
    }
  }
}

export {};
