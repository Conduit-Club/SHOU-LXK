import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = createRequire(require.resolve("wrangler/package.json"))("miniflare");

test("real workerd Cache API shares public data across requests and invalidates after a write", async () => {
  const root = new URL("../src/lib/server/", import.meta.url);
  const modules = await Promise.all(
    ["home-cache", "home-queries", "public-review"].map(async (name) => ({
      type: "ESModule",
      path: fileURLToPath(new URL(`${name}.js`, root)),
      contents: stripTypeScriptTypes(await readFile(new URL(`${name}.ts`, root), "utf8")),
    })),
  );
  const script = `
    import { loadHomePublicData, loadLandingData, invalidateHomeReviews } from './home-cache.js';
    export default { async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === '/invalidate') {
        await invalidateHomeReviews(url);
        return new Response('invalidated');
      }
      let rowsRead = 0, queries = 0;
      const record = r => { rowsRead += r.meta.rows_read; queries++; return r; };
      const wrap = s => ({
        bind: (...v) => wrap(s.bind(...v)),
        all: async () => record(await s.all()),
        first: async () => record(await s.all()).results[0] ?? null,
        rawStatement: s,
      });
      const db = {
        prepare: sql => wrap(env.DB.prepare(sql)),
        batch: async statements => (await env.DB.batch(statements.map(s => s.rawStatement))).map(record),
      };
      const data = await (url.pathname === '/landing' ? loadLandingData : loadHomePublicData)(db, url);
      return Response.json({ data, rowsRead, queries });
    }};
  `;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: "public-cache-local-test",
      compatibilityDate: "2026-09-24",
      cf: false,
      telemetry: { enabled: false },
      d1Databases: ["DB"],
      modules: [
        { type: "ESModule", path: fileURLToPath(new URL("cache-test-entry.js", root)), contents: script },
        ...modules,
      ],
    }),
  );
  try {
    const db = await mf.getD1Database("DB");
    await db.prepare(await readFile(new URL("../schema.sql", import.meta.url), "utf8")).run();
    const first = await (await mf.dispatchFetch("http://localhost/")).json();
    assert.equal(first.queries, 6);
    const warm = await (
      await mf.dispatchFetch("http://localhost/?q=math&page=2", { headers: { Cookie: "not-cached=private" } })
    ).json();
    assert.equal(warm.queries, 0);
    assert.equal(warm.rowsRead, 0);
    await db
      .prepare(`INSERT INTO courses VALUES ('001','Course');
      INSERT INTO course_section(lid,course_id,college,elective_type,credits) VALUES ('1','001','c','e',1);
      INSERT INTO course_reviews(lid,title,content,posted_at_local) VALUES ('1','local review','body','2026-01-01');`)
      .run();
    const stale = await (await mf.dispatchFetch("http://localhost/")).json();
    assert.equal(stale.data.stats.reviews, 0);
    await mf.dispatchFetch("http://localhost/invalidate", { method: "POST" });
    const fresh = await (await mf.dispatchFetch("http://localhost/")).json();
    assert.equal(fresh.queries, 2);
    assert.equal(fresh.data.stats.reviews, 1);
    assert.equal(fresh.data.latestReviews[0].title, "local review");
    assert.equal(JSON.stringify(fresh.data).includes("private"), false);
    // Same real Cache API, new homepage adds only two small directory reads;
    // the second request (a different user cookie) runs no SQL at all.
    const landing = await (await mf.dispatchFetch("http://localhost/landing")).json();
    assert.equal(landing.queries, 2);
    assert.equal(landing.data.newCourses.length, 1);
    const nextUser = await (
      await mf.dispatchFetch("http://localhost/landing", { headers: { Cookie: "new-user=yes" } })
    ).json();
    assert.equal(nextUser.queries, 0);
    assert.equal(nextUser.rowsRead, 0);
  } finally {
    await mf.dispose();
  }
});
