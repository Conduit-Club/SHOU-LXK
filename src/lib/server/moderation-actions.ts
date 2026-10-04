import { fail } from "@sveltejs/kit";
import {
  archiveReview,
  restoreReview,
  setUserBan,
  requireAdminPost,
  reviewKind,
  targetId,
  moderationReason,
} from "#lib/server/moderation.js";
import type { Actions } from "@sveltejs/kit";

export const moderationActions = {
  archiveReview: async (event) => {
    const form = await event.request.formData();
    const context = await requireAdminPost(event, form);
    const changed = await archiveReview(
      context,
      reviewKind(form.get("reviewType")),
      targetId(form.get("reviewId")),
      moderationReason(form.get("reason")),
      event.url,
    );
    return changed
      ? { moderation: true, message: "点评已移入已删除列表，可以恢复。" }
      : fail(409, { moderation: true, message: "点评状态已变化或权限已失效，请刷新查看。" });
  },
  restoreReview: async (event) => {
    const form = await event.request.formData();
    const context = await requireAdminPost(event, form);
    const changed = await restoreReview(
      context,
      reviewKind(form.get("reviewType")),
      targetId(form.get("reviewId")),
      moderationReason(form.get("reason")),
      event.url,
    );
    return changed
      ? { moderation: true, message: "点评已恢复，原编号和发表时间保留。" }
      : fail(409, { moderation: true, message: "点评状态已变化或权限已失效，请刷新查看。" });
  },
  banUser: async (event) => {
    const form = await event.request.formData();
    const context = await requireAdminPost(event, form);
    const changed = await setUserBan(context, targetId(form.get("userId")), true, moderationReason(form.get("reason")));
    return changed
      ? { moderation: true, message: "账号已在本站封禁，本站会话已撤销；现有点评保留。" }
      : fail(409, { moderation: true, message: "账号状态已变化或权限已失效，请刷新查看。" });
  },
  unbanUser: async (event) => {
    const form = await event.request.formData();
    const context = await requireAdminPost(event, form);
    const changed = await setUserBan(
      context,
      targetId(form.get("userId")),
      false,
      moderationReason(form.get("reason")),
    );
    return changed
      ? { moderation: true, message: "本站封禁已解除；用户需要重新登录。" }
      : fail(409, { moderation: true, message: "账号状态已变化或权限已失效，请刷新查看。" });
  },
} satisfies Actions;
