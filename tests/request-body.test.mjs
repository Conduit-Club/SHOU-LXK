import "./helpers/server-imports.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
const { handle } = await import("../src/hooks.server.ts");

test("unauthenticated POST streams exceeding 64 KiB are cancelled before parsing or D1", async () => {
  for (const format of ["urlencoded", "multipart"])
    for (const contentLength of [undefined, "1"]) {
      let pulls = 0;
      let cancelled = false;
      let resolved = false;
      const size = 16 * 1024;
      const chunk = new TextEncoder().encode("x".repeat(size));
      const body = new ReadableStream({
        pull(controller) {
          pulls++;
          if (pulls === 1) {
            const prefix =
              format === "urlencoded"
                ? "content="
                : '--local-boundary\r\nContent-Disposition: form-data; name="content"\r\n\r\n';
            controller.enqueue(new TextEncoder().encode(prefix + "x".repeat(size - prefix.length)));
          } else if (pulls === 65) {
            if (format === "multipart") controller.enqueue(new TextEncoder().encode("\r\n--local-boundary--\r\n"));
            controller.close();
          } else controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      });
      const url = new URL("https://local.test/courses/001?/submitReview");
      const request = new Request(url, {
        method: "POST",
        body,
        duplex: "half",
        headers: {
          "content-type":
            format === "urlencoded"
              ? "application/x-www-form-urlencoded"
              : "multipart/form-data; boundary=local-boundary",
          origin: url.origin,
          ...(contentLength ? { "content-length": contentLength } : {}),
        },
      });
      const response = await handle({
        event: {
          request,
          url,
          locals: {},
          cookies: {
            get() {
              throw new Error("Must not authenticate an oversized body");
            },
          },
          platform: {
            env: {
              get DB() {
                throw new Error("D1 must not be touched");
              },
            },
          },
        },
        resolve: async (event) => {
          resolved = true;
          await event.request.formData();
          return new Response("unauthenticated", { status: 401 });
        },
      });
      assert.equal(response.status, 413);
      assert.equal(resolved, false);
      assert.equal(cancelled, true);
      assert.ok(pulls <= 6, `read only bounded chunks, got ${pulls}`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("content-security-policy"), "frame-ancestors 'none'");
    }
});

test("stream read failures return a generic 400 without parsing or authentication", async () => {
  const url = new URL("https://local.test/auth/logout");
  const request = new Request(url, {
    method: "POST",
    body: new ReadableStream({
      pull(controller) {
        controller.error(new Error("Private upstream transport detail"));
      },
    }),
    duplex: "half",
  });
  const response = await handle({
    event: {
      request,
      url,
      platform: {
        env: {
          get DB() {
            throw new Error("D1 must not be touched");
          },
        },
      },
    },
    resolve() {
      throw new Error("Must not parse a failed request body");
    },
  });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal((await response.text()).includes("Private upstream"), false);
});

test("bounded URL-encoded and multipart forms retain their fields, Origin and CSRF headers", async () => {
  const url = new URL("https://local.test/courses/001?/submitReview");
  for (const body of [
    new URLSearchParams({ csrfToken: "local", content: "汉字 & text" }),
    (() => {
      const form = new FormData();
      form.set("csrfToken", "local");
      form.set("content", "汉字 & text");
      return form;
    })(),
  ]) {
    const request = new Request(url, {
      method: "POST",
      body,
      headers: { origin: url.origin, cookie: "opaque-session=value" },
    });
    const response = await handle({
      event: { request, url, locals: {}, cookies: { get: () => undefined }, platform: { env: {} } },
      resolve: async (event) => {
        assert.equal(event.request.headers.get("origin"), url.origin);
        assert.equal(event.request.headers.get("cookie"), "opaque-session=value");
        const form = await event.request.formData();
        assert.equal(form.get("csrfToken"), "local");
        assert.equal(form.get("content"), "汉字 & text");
        return new Response("normal form", { status: 200 });
      },
    });
    assert.equal(response.status, 200);
  }
});
