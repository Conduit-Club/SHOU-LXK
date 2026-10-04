import { error } from "@sveltejs/kit";
import type { AuthSession } from "./auth.js";

// Only the publication choice is accepted from the form. The public identity
// comes from the authenticated Auth profile, never a submitted name/avatar.
export function reviewIdentity(form: FormData, session: AuthSession) {
  const choice = form.get("visibility") ?? "anonymous";
  if (choice !== "anonymous" && choice !== "username") error(400, "请选择匿名或账号用户名发表。");
  if (!session.username) error(401, "请重新登录并补充统一账号用户名后再发表点评。");
  return choice === "anonymous"
    ? { visibility: "anonymous" as const, anonymous: 1, username: null, avatar: null }
    : { visibility: "username" as const, anonymous: 0, username: session.username, avatar: session.avatarUrl };
}

export { publicReviewProjection } from "./public-review.js";
export type { PublicReviewIdentity } from "./public-review.js";
