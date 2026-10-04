import "./helpers/server-imports.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
const { handle } = await import("../src/hooks.server.ts");

test("maintenance blocks loaders, data requests and writes without touching D1", async () => {
  for (const [method, path] of [
    ["GET", "/"],
    ["GET", "/courses/7109911/__data.json"],
    ["POST", "/courses/7109911?/submitReview"],
  ]) {
    const response = await handle({
      event: {
        platform: {
          env: {
            MAINTENANCE_MODE: "true",
            get DB() {
              throw Error("D1 must not be touched");
            },
          },
        },
        request: new Request("https://local.test" + path, { method }),
      },
      resolve: () => {
        throw Error("Application must not be resolved");
      },
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("retry-after"), "600");
    assert.match(await response.text(), /网站暂时维护中/);
  }
});

test("maintenance only ends when the operator explicitly disables it", async () => {
  for (const value of [undefined, "false"]) {
    const expected = new Response("normal page");
    const event = {
      platform: { env: { MAINTENANCE_MODE: value } },
      locals: {},
      url: new URL("https://local.test/"),
      cookies: { get: () => undefined },
    };
    assert.equal(
      await handle({
        event,
        resolve: async (actual) => {
          assert.equal(actual, event);
          return expected;
        },
      }),
      expected,
    );
  }
});
