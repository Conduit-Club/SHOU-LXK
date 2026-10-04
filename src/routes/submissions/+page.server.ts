import { error, fail, isHttpError, redirect } from "@sveltejs/kit";
import { requestSession } from "#lib/server/auth.js";
import { getBindings } from "#lib/server/platform.js";
import {
  loadOwnSubmissions,
  loadOwnSubmission,
  parseCatalogDraft,
  publishCatalog,
  requireSubmitter,
  submissionId,
  submitCatalog,
} from "#lib/server/catalog-submissions.js";
import { verifyTurnstile } from "#lib/server/turnstile.js";
import { requireAdminPost } from "#lib/server/moderation.js";
import type { PageServerLoad, Actions } from "./$types";

export const load: PageServerLoad = async (event) => {
  const actor = await requestSession(event);
  const context = actor?.username ? await requireSubmitter(event) : null;
  const resultId = event.url.searchParams.get("result");
  return {
    kind: event.url.searchParams.get("kind") === "teacher" ? ("teacher" as const) : ("course" as const),
    submissionId: crypto.randomUUID(),
    resultSubmission: context && resultId ? await loadOwnSubmission(context, resultId) : null,
    canPublishDirectly: actor?.isAdmin ?? false,
    adminNeedsRenewal: !!actor?.canRenewAdmin && !actor.isAdmin,
    turnstileSiteKey: getBindings(event.platform).TURNSTILE_SITE_KEY ?? "",
    ...(context
      ? await loadOwnSubmissions(context, event.url)
      : {
          submissions: [],
          page: 1,
          pages: 1,
          pageSize: 20,
          total: 0,
          offset: 0,
        }),
  };
};

export const actions = {
  submit: async (event) => {
    const form = await event.request.formData();
    const context = await requireSubmitter(event, form);
    const values = Object.fromEntries(
      ["kind", "name", "courseId", "college", "electiveType", "credits", "lid", "note", "submissionId"].map((key) => [
        key,
        typeof form.get(key) === "string" ? String(form.get(key)).slice(0, 1100) : "",
      ]),
    );
    const direct = context.actor.isAdmin || form.get("submissionMode") === "direct" || context.actor.canRenewAdmin;
    try {
      // A form rendered for an administrator keeps its direct-publication intent
      // even when the short-lived role expires. Never downgrade it to pending.
      if (context.actor.canRenewAdmin && !context.actor.isAdmin)
        error(403, "管理员权限已到期，请重新验证后直接收录；本次没有保存为待审补充。");
      const admin = direct ? await requireAdminPost(event, form) : null;
      const id = submissionId(form.get("submissionId"));
      const draft = parseCatalogDraft(form);
      const verification = await verifyTurnstile(
        form,
        getBindings(event.platform).TURNSTILE_SECRET_KEY,
        event.url.hostname,
        event.fetch,
        "submit_catalog",
      );
      if (!verification.success)
        return fail(verification.status, { message: verification.message, values, renewAdmin: false });
      if (admin) await publishCatalog(context, admin, id, draft, event.url);
      else await submitCatalog(context, id, draft);
      redirect(303, `/submissions?${new URLSearchParams({ kind: draft.kind, result: id })}`);
    } catch (reason) {
      if (isHttpError(reason) && [400, 403, 409, 429].includes(reason.status))
        return fail(reason.status, {
          message: reason.body.message,
          values,
          renewAdmin: context.actor.canRenewAdmin && direct && reason.status === 403,
        });
      throw reason;
    }
  },
} satisfies Actions;
