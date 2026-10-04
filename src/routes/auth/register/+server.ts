import { redirect } from "@sveltejs/kit";
import { authError, beginLogin } from "#lib/server/auth.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
  let destination: string;
  try {
    destination = await beginLogin(event, true);
  } catch (reason) {
    authError(reason);
  }
  redirect(303, destination, { external: [new URL(destination).origin] });
};
