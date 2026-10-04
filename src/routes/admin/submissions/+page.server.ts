import { fail, isHttpError } from "@sveltejs/kit";
import { requireAdmin, requireAdminPost, moderationReason } from "#lib/server/moderation.js";
import { decideCatalog, loadCatalogQueue, submissionId } from "#lib/server/catalog-submissions.js";
import type { PageServerLoad, Actions } from "./$types";

export const load: PageServerLoad = async (event) => loadCatalogQueue(await requireAdmin(event), event.url);

export const actions = {
  decide: async (event) => {
    const form = await event.request.formData();
    const context = await requireAdminPost(event, form);
    try {
      const id = submissionId(form.get("submissionId"));
      const decision = form.get("decision");
      if (decision !== "approve" && decision !== "reject")
        return fail(400, { message: "请选择通过或拒绝。", submissionId: id });
      const changed = await decideCatalog(
        context,
        id,
        decision === "approve",
        moderationReason(form.get("reason")),
        form,
        event.url,
      );
      return changed
        ? {
            message: decision === "approve" ? "审核通过，条目已进入公开目录。" : "已拒绝，提交者可查看审核理由。",
            submissionId: id,
          }
        : fail(409, {
            message: "状态或权限已变化，或课程号、班级编号、老师已收录。请刷新核对，重复条目可填写理由拒绝。",
            submissionId: id,
          });
    } catch (reason) {
      if (isHttpError(reason) && reason.status === 400)
        return fail(400, { message: reason.body.message, submissionId: String(form.get("submissionId")) });
      throw reason;
    }
  },
} satisfies Actions;
