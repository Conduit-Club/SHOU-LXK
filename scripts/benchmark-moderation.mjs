// Copies a local, read-only SQLite snapshot into ephemeral workerd D1.
// Does not use Cloudflare credentials, remote Wrangler or production requests.
import "../tests/helpers/server-imports.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  copyLocalData,
  executeScript,
  localD1,
  measureDatabase,
  migration,
  profileMigrations,
} from "../tests/helpers/local-d1.mjs";
import { legacyManagedReviews } from "../tests/helpers/legacy-moderation.mjs";
const { loadManagedReviews } = await import("../src/lib/server/moderation.ts");

const args = process.argv.slice(2);
const source = args[args.indexOf("--database") + 1];
if (!args.includes("--database") || !source || source.startsWith("--") || /^(https?:|file:)/i.test(source))
  throw new Error("Pass --database <local SQLite file>");
const local = await localD1();
try {
  const counts = await copyLocalData(local.db, resolve(source), console.log);
  await executeScript(local.db, await migration());
  await executeScript(local.db, await profileMigrations());
  const section = await local.db
    .prepare("SELECT lid,course_id FROM course_section ORDER BY review_count DESC,lid LIMIT 1")
    .first();
  const cases = [
    ["all", ""],
    ["deep-page", "?page=100"],
    ["oldest", "?sort=oldest"],
    ["courses", "?type=course"],
    ["teachers", "?type=teacher"],
    ["text-search", "?q=老师"],
    ["empty-search", "?q=__no_such_review__"],
    ["target-search", "?target=人工智能"],
    ["legacy", "?ownership=legacy"],
    ["known", "?ownership=known"],
    ["author", "?author=%232"],
    ["banned", "?banned=yes"],
    ["not-banned", "?banned=no"],
    ["deleted", "?status=deleted"],
    ["deleted-courses", "?status=deleted&type=course"],
    ...(section
      ? [
          ["course-detail", "", { kind: "course", courseId: section.course_id }],
          ["section-detail", "", { kind: "course", courseId: section.course_id, lid: section.lid }],
        ]
      : []),
  ];
  const report = [];
  for (const [name, query, scope = {}] of cases) {
    const url = new URL("/admin" + query, "https://local-budget.invalid");
    const runs = [];
    let expected;
    for (const [phase, load] of [
      ["before", legacyManagedReviews],
      ["after", loadManagedReviews],
    ]) {
      const measured = measureDatabase(local.db);
      const data = await load(
        { db: measured.db, actor: { userId: -1 }, issuer: "https://auth.shoumc.com/api/auth" },
        url,
        scope,
      );
      if (phase === "before") expected = data;
      else assert.deepEqual(data, expected, `${name}: result, total or ordering changed`);
      runs.push({ phase, ...measured.metrics, statements: measured.statements });
    }
    report.push({ name, query, scope, total: expected.total, returned: expected.reviews.length, runs });
  }
  const output = resolve(".wrangler/read-budget/moderation.json");
  await mkdir(resolve(".wrangler/read-budget"), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        runtime: "local Miniflare/workerd; review count/list only, excludes authentication/audit; source read-only",
        counts,
        cases: report,
      },
      null,
      2,
    ) + "\n",
  );
  console.table(
    report.map(({ name, runs }) => ({
      name,
      beforeRead: runs[0].rowsRead,
      afterRead: runs[1].rowsRead,
      beforeWrite: runs[0].rowsWritten,
      afterWrite: runs[1].rowsWritten,
    })),
  );
  console.log(output);
} finally {
  await local.close();
}
