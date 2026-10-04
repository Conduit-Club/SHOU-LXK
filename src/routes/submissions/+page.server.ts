import { fail, isHttpError, redirect } from "@sveltejs/kit";
import { requestSession } from "#lib/server/auth.js";
import { getBindings } from "#lib/server/platform.js";
import {
  loadOwnSubmissions,
  parseCatalogDraft,
  requireSubmitter,
  submissionId,
  submitCatalog,
} from "#lib/server/catalog-submissions.js";
import { verifyTurnstile } from "#lib/server/turnstile.js";
import type { PageServerLoad, Actions } from "./$types";

export const load: PageServerLoad = async (event) => {
  const actor = await requestSession(event);
  return {
    kind: event.url.searchParams.get("kind") === "teacher" ? ("teacher" as const) : ("course" as const),
    submissionId: crypto.randomUUID(),
    submitted: event.url.searchParams.get("submitted") === "1",
    turnstileSiteKey: getBindings(event.platform).TURNSTILE_SITE_KEY ?? "",
    ...(actor?.username
      ? await loadOwnSubmissions(await requireSubmitter(event), event.url)
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
    try {
      const id = submissionId(form.get("submissionId"));
      const draft = parseCatalogDraft(form);
      const verification = await verifyTurnstile(
        form,
        getBindings(event.platform).TURNSTILE_SECRET_KEY,
        event.url.hostname,
        event.fetch,
        "submit_catalog",
      );
      if (!verification.success) return fail(verification.status, { message: verification.message, values });
      await submitCatalog(context, id, draft);
      redirect(303, `/submissions?${new URLSearchParams({ kind: draft.kind, submitted: "1" })}`);
    } catch (reason) {
      if (isHttpError(reason) && [400, 409, 429].includes(reason.status))
        return fail(reason.status, { message: reason.body.message, values });
      throw reason;
    }
  },
} satisfies Actions;
