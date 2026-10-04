import { loadModeration, requireAdmin } from "#lib/server/moderation.js";
import { moderationActions } from "#lib/server/moderation-actions.js";
import type { PageServerLoad } from "./$types";
export const load: PageServerLoad = async (event) => loadModeration(await requireAdmin(event), event.url);
export const actions = moderationActions;
