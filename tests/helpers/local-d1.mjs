import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
// Use the same local runtime shipped with the pinned Wrangler. No credentials,
// remote proxy binding, production database ID, or outgoing fetch is configured.
const { Miniflare, convertV4MiniflareOptions } = createRequire(require.resolve("wrangler/package.json"))("miniflare");

export async function localD1() {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: "read-budget-local-test",
      compatibilityDate: "2026-09-24",
      modules: true,
      script: "export default { fetch() { return new Response('local test only'); } }",
      d1Databases: ["DB"],
      cf: false,
      telemetry: { enabled: false },
    }),
  );
  return { db: await mf.getD1Database("DB"), close: () => mf.dispose() };
}

export const migration = () => readFile(new URL("../../migrations/0005_home_read_budget.sql", import.meta.url), "utf8");
export async function profileMigrations() {
  return (
    await Promise.all(
      ["0006_unified_auth.sql", "0007_admin_moderation.sql", "0008_profiles_and_review_visibility.sql"].map((name) =>
        readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8"),
      ),
    )
  ).join("\n");
}
export function withoutPublicIdentity(rows) {
  return rows.map(({ display_name: _name, avatar_url: _avatar, ...row }) => row);
}

export async function executeScript(db, sql) {
  // D1.exec splits on newlines; prepare/run supports a multiline SQL script,
  // including trigger bodies. Used ONLY for local setup and migrations.
  return db.prepare(sql).run();
}

const tables = [
  "courses",
  "course_section",
  "teachers",
  "course_section_teachers",
  "course_reviews",
  "teacher_reviews",
  "category_options",
];
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const literal = (value) => {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  throw new Error("Unexpected non-scalar local SQLite value");
};

export async function copyLocalData(db, filename, progress = () => {}) {
  const source = new DatabaseSync(filename, { readOnly: true });
  try {
    // One read transaction gives a consistent snapshot, including any WAL.
    source.exec("BEGIN");
    const objects = source
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL")
      .all()
      .filter((object) => tables.includes(object.tbl_name));
    // Preserve the pre-0005 schema for a fair before/after comparison even if
    // the developer's local DB has already been migrated.
    await executeScript(db, await readFile(new URL("../fixtures/schema-before-0005.sql", import.meta.url), "utf8"));
    await executeScript(
      db,
      `DROP TRIGGER course_reviews_count_insert;
      DROP TRIGGER course_reviews_count_delete; DROP TRIGGER course_reviews_count_move;`,
    );
    const counts = {};
    for (const table of tables) {
      // Benchmarks copy public pre-0005 fields only, even when the source local
      // snapshot has later nullable author columns or authentication tables.
      const columns = (await db.prepare(`PRAGMA table_info(${quote(table)})`).all()).results
        .map((column) => quote(column.name))
        .join(",");
      const rows = source.prepare(`SELECT ${columns} FROM ${quote(table)}`).all();
      counts[table] = rows.length;
      progress(`Copying ${table}: ${rows.length} local rows`);
      if (rows.length) {
        const prefix = `INSERT INTO ${quote(table)} (${Object.keys(rows[0]).map(quote).join(",")}) VALUES `;
        let values = [];
        let bytes = 0;
        for (const row of rows) {
          const value = `(${Object.values(row).map(literal).join(",")})`;
          if (values.length && bytes + Buffer.byteLength(value) > 64_000) {
            await executeScript(db, prefix + values.join(","));
            values = [];
            bytes = 0;
          }
          values.push(value);
          bytes += Buffer.byteLength(value) + 1;
        }
        if (values.length) await executeScript(db, prefix + values.join(","));
      }
    }
    for (const object of objects.filter(
      (object) => object.type === "trigger" && object.name.startsWith("course_reviews_count_"),
    )) {
      await executeScript(db, object.sql);
    }
    source.exec("COMMIT");
    return counts;
  } finally {
    source.close();
  }
}

export class MemoryCache {
  entries = new Map();
  async match(request) {
    return this.entries.get(request.url)?.clone();
  }
  async put(request, response) {
    this.entries.set(request.url, response.clone());
  }
  async delete(request) {
    return this.entries.delete(request.url);
  }
}

export function measureDatabase(db) {
  const metrics = { rowsRead: 0, queries: 0 };
  const statements = [];
  const record = (result, sql) => {
    metrics.queries++;
    metrics.rowsRead += result.meta.rows_read;
    statements.push({ sql, rowsRead: result.meta.rows_read });
    return result;
  };
  const wrap = (statement, sql) => ({
    bind: (...values) => wrap(statement.bind(...values), sql),
    all: async () => record(await statement.all(), sql),
    first: async () => record(await statement.all(), sql).results[0] ?? null,
    run: async () => record(await statement.run(), sql),
    rawStatement: statement,
    sql,
  });
  return {
    metrics,
    statements,
    db: {
      prepare: (sql) => wrap(db.prepare(sql), sql),
      batch: async (batch) =>
        (await db.batch(batch.map((statement) => statement.rawStatement))).map((result, index) =>
          record(result, batch[index].sql),
        ),
    },
  };
}
