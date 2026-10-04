type Verification = { success: true } | { success: false; status: 400 | 503; message: string };

export async function verifyTurnstile(
  form: FormData,
  secret: string | undefined,
  hostname: string,
  fetcher: typeof fetch,
  action = "submit_review",
): Promise<Verification> {
  const unavailable = { success: false, status: 503, message: "验证服务暂时不可用，请稍后重试。" } as const;
  if (!secret) return unavailable;
  const token = form.get("cf-turnstile-response");
  const invalid = { success: false, status: 400, message: "请重新完成人机验证后提交。" } as const;
  if (typeof token !== "string" || !token || token.length > 2048) return invalid;

  try {
    const response = await fetcher("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret, response: token }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return unavailable;
    const result: { success?: boolean; hostname?: string; action?: string } = await response.json();
    // Public testing keys return synthetic metadata. Accept it only for local development.
    const localTest =
      ["localhost", "127.0.0.1", "[::1]"].includes(hostname) && secret === "1x0000000000000000000000000000000AA";
    if (result.success !== true || (!localTest && (result.hostname !== hostname || result.action !== action))) {
      return invalid;
    }
    return { success: true };
  } catch {
    return unavailable;
  }
}
