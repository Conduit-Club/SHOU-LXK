import { fail } from "@sveltejs/kit";
import {
  archiveReview,
  restoreReview,
  setUserBan,
  loadModeration,
  requireAdmin,
  requireAdminPost,
  reviewKind,
  targetId,
  moderationReason,
} from "#lib/server/moderation.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => loadModeration(await requireAdmin(event), event.url);

export const actions: Actions = {
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
      ? { message: "点评已移入已删除列表，可以恢复。" }
      : fail(409, { message: "点评状态已变化或权限已失效，请刷新查看。" });
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
      ? { message: "点评已恢复，原编号和发表时间保留。" }
      : fail(409, { message: "点评状态已变化或权限已失效，请刷新查看。" });
  },
  banUser: async (event) => {
    const form = await event.request.formData();
    const context = await requireAdminPost(event, form);
    const changed = await setUserBan(context, targetId(form.get("userId")), true, moderationReason(form.get("reason")));
    return changed
      ? { message: "账号已在本站封禁，本站会话已撤销；现有点评保留。" }
      : fail(409, { message: "账号状态已变化或权限已失效，请刷新查看。" });
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
      ? { message: "本站封禁已解除；用户需要重新登录。" }
      : fail(409, { message: "账号状态已变化或权限已失效，请刷新查看。" });
  },
};
