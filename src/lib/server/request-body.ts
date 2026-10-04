export const MAX_POST_BODY_BYTES = 64 * 1024;

// Cloudflare's adapter does not impose Node adapter's body-size limit. Bound
// actual stream bytes before any action parses multipart or authenticates.
// Content-Length can be absent or misleading, so it is never the authority.
export async function boundedPostRequest(request: Request): Promise<Request | null> {
  if (request.method !== "POST" || !request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value.byteLength) continue;
      size += value.byteLength;
      if (size > MAX_POST_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request, { method: "POST", body });
}
