import { redirect } from "@sveltejs/kit";
import { authError, endSession } from "#lib/server/auth.js";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
  let destination: string;
  try {
    destination = await endSession(event);
  } catch (reason) {
    authError(reason);
  }
  redirect(303, destination);
};
