import { redirect } from "@sveltejs/kit";
import { authError, completeLogin } from "#lib/server/auth.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
  let destination: string;
  try {
    destination = await completeLogin(event);
  } catch (reason) {
    authError(reason);
  }
  redirect(303, destination);
};
