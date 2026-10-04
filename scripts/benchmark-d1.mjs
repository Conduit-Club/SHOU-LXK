// Explicitly local: read a SQLite file in read-only mode, copy into an ephemeral
// Miniflare DB, and run both versions there. This never invokes Wrangler/Cloudflare.
import "../tests/helpers/server-imports.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import {
  copyLocalData,
  executeScript,
  localD1,
  measureDatabase,
  MemoryCache,
  migration,
  profileMigrations,
  withoutPublicIdentity,
} from "../tests/helpers/local-d1.mjs";
import { legacyLatest, legacyStats, legacyCatalog, legacyOptions } from "../tests/helpers/legacy-queries.mjs";

const { LATEST_REVIEWS_SQL, SITE_STATS_SQL, OPTION_SQL, catalogQueries, parseHomeFilters } =
  await import("../src/lib/server/home-queries.ts");
const { loadHomePublicData } = await import("../src/lib/server/home-cache.ts");
const args = process.argv.slice(2);
const filename = args[args.indexOf("--database") + 1];
if (!args.includes("--database") || !filename || filename.startsWith("--") || /^(https?:|file:)/i.test(filename)) {
  throw new Error("Usage: pixi run pnpm benchmark:d1 --database <local SQLite filename>");
}
const output = resolve(".wrangler/read-budget/benchmark.json");
const local = await localD1();
try {
  const db = local.db;
  console.log("Ephemeral local D1 ready");
  const counts = await copyLocalData(db, resolve(filename), console.log);
  const cases = [
    { name: "latest", before: legacyLatest, after: LATEST_REVIEWS_SQL, values: [] },
    { name: "stats", before: legacyStats, after: SITE_STATS_SQL, values: [] },
    ...Object.entries(OPTION_SQL).map(([name, sql]) => ({
      name: `options.${name}`,
      before: legacyOptions[name],
      after: sql,
      values: [],
    })),
  ];
  const selections = [
    ["all", {}],
    ["course-search", { q: "人工智能" }],
    ["teacher", { teacher: "关欣" }],
    ["college", { college: "信息学院" }],
    ["type", { electiveType: "必修" }],
    ["credits", { credits: "2" }],
    ["attribute", { attribute: "理论课" }],
    ["min-reviews", { minReviews: "10" }],
    ["combined", { q: "人工智能", teacher: "关", college: "信息学院", credits: "2", minReviews: "1" }],
    ["empty", { q: "__not_a_real_course__" }],
  ];
  // Choose a real nonempty attribute rather than rely on a particular archive.
  const attribute = (await db.prepare(OPTION_SQL.attributes).all()).results.find(
    (row) => row.value === row.value.trim(),
  );
  if (attribute) selections.find(([name]) => name === "attribute")[1].attribute = attribute.value;
  for (const [name, params] of selections) {
    const filters = parseHomeFilters(new URLSearchParams(params));
    const old = legacyCatalog(filters);
    const current = catalogQueries(filters);
    cases.push({ name: `count.${name}`, before: old.count, after: current.count, values: old.values });
    for (const sort of ["reviews", "name", "credits"]) {
      const oldList = legacyCatalog({ ...filters, sort });
      const newList = catalogQueries({ ...filters, sort });
      for (const offset of [0, 12, 120]) {
        cases.push({
          name: `list.${name}.${sort}.offset${offset}`,
          before: oldList.list,
          after: newList.list,
          values: [...oldList.values, 12, offset],
        });
      }
    }
  }

  async function measure(sql, values) {
    const result = await db
      .prepare(sql)
      .bind(...values)
      .all();
    const plan = await db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...values)
      .all();
    return { results: result.results, rowsRead: result.meta.rows_read, plan: plan.results.map((row) => row.detail) };
  }
  const before = [];
  console.log(`Measuring ${cases.length} baseline queries`);
  for (const entry of cases) before.push(await measure(entry.before, entry.values));
  await executeScript(db, await migration());
  await executeScript(db, await profileMigrations());
  console.log("Migration 0005 applied to ephemeral local D1; comparing optimized queries");
  const report = [];
  for (let index = 0; index < cases.length; index++) {
    const entry = cases[index];
    const after = await measure(entry.after, entry.values);
    assert.deepEqual(
      withoutPublicIdentity(after.results),
      before[index].results,
      `${entry.name}: changed query result/order`,
    );
    report.push({
      name: entry.name,
      values: entry.values,
      rowsReturned: after.results.length,
      before: { rowsRead: before[index].rowsRead, plan: before[index].plan },
      after: { rowsRead: after.rowsRead, plan: after.plan },
    });
  }
  const cache = new MemoryCache();
  const measured = measureDatabase(db);
  await loadHomePublicData(measured.db, new URL("http://localhost:5173/"), Promise.resolve(cache));
  const cold = { ...measured.metrics };
  for (let page = 1; page <= 10; page++) {
    await loadHomePublicData(
      measured.db,
      new URL(`http://localhost:5173/?q=人工智能&credits=2&page=${page}`),
      Promise.resolve(cache),
    );
  }
  const warm = {
    queries: measured.metrics.queries - cold.queries,
    rowsRead: measured.metrics.rowsRead - cold.rowsRead,
  };
  assert.equal(warm.rowsRead, 0);
  assert.equal(warm.queries, 0);
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  assert.deepEqual(await db.prepare(SITE_STATS_SQL).first(), await db.prepare(legacyStats).first());
  const result = {
    measuredAt: new Date().toISOString(),
    source: resolve(filename),
    runtime: "local Miniflare/workerd only",
    counts,
    comparedQueries: cases.length,
    publicCache: { cold, tenWarmRequests: warm },
    queries: report,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.table(
    report
      .filter((entry) => !entry.name.startsWith("list."))
      .map((entry) => ({
        query: entry.name,
        before: entry.before.rowsRead,
        after: entry.after.rowsRead,
      })),
  );
  console.log(JSON.stringify({ comparedQueries: cases.length, publicCache: result.publicCache, output }, null, 2));
} finally {
  await local.close();
}
