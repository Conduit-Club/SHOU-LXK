import "../tests/helpers/server-imports.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  copyLocalData,
  executeScript,
  localD1,
  measureDatabase,
  MemoryCache,
  migration,
  profileMigrations,
} from "../tests/helpers/local-d1.mjs";
const { load: home } = await import("../src/routes/+page.server.ts");
const { load: courses } = await import("../src/routes/courses/+page.server.ts");
const { load: reviews } = await import("../src/routes/reviews/+page.server.ts");
const { load: teachers } = await import("../src/routes/teachers/+page.server.ts");

const args = process.argv.slice(2);
const source = args[args.indexOf("--database") + 1];
if (!args.includes("--database") || !source || source.startsWith("--") || /^(https?:|file:)/i.test(source))
  throw new Error("Pass --database <local SQLite file>");
const local = await localD1();
const previousCaches = globalThis.caches;
try {
  const counts = await copyLocalData(local.db, resolve(source), console.log);
  await executeScript(local.db, await migration());
  await executeScript(local.db, await profileMigrations());
  const report = [];
  for (const [name, load, path] of [
    ["home", home, "/"],
    ["courses", courses, "/courses"],
    ["reviews", reviews, "/reviews"],
    ["teachers", teachers, "/teachers"],
    ["course-search", courses, "/courses?q=人工智能"],
    ["review-search", reviews, "/reviews?q=老师"],
    ["teacher-search", teachers, "/teachers?q=关欣"],
  ]) {
    const cache = new MemoryCache();
    globalThis.caches = { open: async () => cache };
    const runs = [];
    for (const state of ["cold", "warm"]) {
      const measured = measureDatabase(local.db);
      const data = await load({ platform: { env: { DB: measured.db } }, url: new URL(path, "http://localhost:5173") });
      if (name === "home") {
        assert.equal(data.latestReviews.length, 5);
        assert.equal(data.newCourses.length, 5);
        assert.equal(data.newTeachers.length, 5);
        if (state === "warm") assert.equal(measured.metrics.queries, 0);
      }
      runs.push({ state, ...measured.metrics, statements: measured.statements });
    }
    report.push({ name, path, runs });
  }
  const output = resolve(".wrangler/read-budget/pages.json");
  await mkdir(resolve(".wrangler/read-budget"), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        runtime: "local Miniflare/workerd; complete route loaders; source read-only",
        counts,
        pages: report,
      },
      null,
      2,
    ) + "\n",
  );
  console.table(
    report.map(({ name, runs }) => ({
      page: name,
      coldQueries: runs[0].queries,
      coldRows: runs[0].rowsRead,
      warmQueries: runs[1].queries,
      warmRows: runs[1].rowsRead,
    })),
  );
  console.log(output);
} finally {
  globalThis.caches = previousCaches;
  await local.close();
}
