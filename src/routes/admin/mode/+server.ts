import { redirect } from "@sveltejs/kit";
import { MANAGEMENT_COOKIE, requireAdminPost } from "#lib/server/moderation.js";
import { safeReturnTo } from "#lib/server/auth.js";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
  const form = await event.request.formData();
  await requireAdminPost(event, form);
  event.cookies.set(MANAGEMENT_COOKIE, form.get("enabled") === "1" ? "1" : "0", {
    path: "/",
    httpOnly: true,
    secure: event.url.protocol === "https:",
    sameSite: "lax",
    maxAge: 8 * 60 * 60,
  });
  redirect(303, safeReturnTo(typeof form.get("returnTo") === "string" ? (form.get("returnTo") as string) : "/reviews"));
};
