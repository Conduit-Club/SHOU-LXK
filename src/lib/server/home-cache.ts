import { LATEST_REVIEWS_SQL, NEW_COURSES_SQL, NEW_TEACHERS_SQL, OPTION_SQL, SITE_STATS_SQL } from "./home-queries.js";
import type { FilterOptions, LatestReview, NewCourse, NewTeacher, SiteStats } from "./home-queries.js";

// Only public, query-independent data: never HTML, filter results, cookies,
// Turnstile tokens, form values or action responses.
const CACHE_NAME = "shou-lxk-home-v2";
export const HOME_TTL = { options: 6 * 60 * 60, latest: 60, stats: 60, additions: 60, similar: 300 } as const;
type HomeKey = keyof typeof HOME_TTL | `similar/${string}`;
type PublicCache = Pick<Cache, "match" | "put" | "delete">;

async function openCache(): Promise<PublicCache | undefined> {
  try {
    return typeof caches === "undefined" ? undefined : await caches.open(CACHE_NAME);
  } catch {
    // A cache outage must not prevent reads or make a successful review fail.
    return undefined;
  }
}

function cacheRequest(url: URL, key: HomeKey) {
  // Normalize protocol and discard the entire request path, query and headers.
  // Different public hosts/local test ports keep independent namespaces.
  return new Request(`https://${url.host}/__home-cache/v2/${key}`);
}

export async function readHomeCache<T>(
  cache: PublicCache | undefined,
  url: URL,
  key: HomeKey,
  load: () => Promise<T>,
  now = Date.now,
): Promise<T> {
  const request = cacheRequest(url, key);
  if (cache) {
    try {
      const hit = await cache.match(request);
      if (hit) {
        const entry: { expiresAt: number; value: T } = await hit.json();
        if (entry.expiresAt > now() && entry.value !== undefined) return entry.value;
      }
    } catch {
      // Treat malformed/evicted/unavailable entries as misses.
    }
  }
  // Start the lifetime before querying: a slow in-flight read cannot extend
  // stale data past its TTL after a concurrent mutation/invalidation.
  const ttlKey = key.startsWith("similar/") ? "similar" : (key as keyof typeof HOME_TTL);
  const expiresAt = now() + HOME_TTL[ttlKey] * 1000;
  const value = await load(); // Errors are deliberately not cached.
  const remaining = Math.floor((expiresAt - now()) / 1000);
  if (cache && remaining > 0) {
    try {
      await cache.put(
        request,
        new Response(JSON.stringify({ expiresAt, value }), {
          headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${remaining}` },
        }),
      );
    } catch {
      // A lost cache write affects efficiency only; return the fresh DB result.
    }
  }
  return value;
}

async function loadOptions(db: D1Database, url: URL, store: PublicCache | undefined) {
  return readHomeCache<FilterOptions>(store, url, "options", async () => {
    const [colleges, electiveTypes, attributes, credits] = await db.batch<Record<string, string | number>>([
      db.prepare(OPTION_SQL.colleges),
      db.prepare(OPTION_SQL.electiveTypes),
      db.prepare(OPTION_SQL.attributes),
      db.prepare(OPTION_SQL.credits),
    ]);
    return {
      colleges: colleges.results.map((row) => row.value as string),
      electiveTypes: electiveTypes.results.map((row) => row.value as string),
      attributes: attributes.results.map((row) => row.value as string),
      credits: credits.results.map((row) => row.credits as number),
    };
  });
}

export async function loadSiteStats(db: D1Database, url: URL, cache = openCache()) {
  return readHomeCache<SiteStats>(await cache, url, "stats", async () => {
    const stats = await db.prepare(SITE_STATS_SQL).first<SiteStats>();
    if (!stats) throw new Error("Missing site_stats row: apply migration 0005 before serving the home page.");
    return stats;
  });
}

async function loadLatest(db: D1Database, url: URL, store: PublicCache | undefined) {
  return readHomeCache<LatestReview[]>(
    store,
    url,
    "latest",
    async () => (await db.prepare(LATEST_REVIEWS_SQL).all<LatestReview>()).results,
  );
}

// Kept for the before/after SQL benchmark; routes load only what they display.
export async function loadHomePublicData(db: D1Database, url: URL, cache = openCache()) {
  const store = await cache;
  const [options, latestReviews, stats] = await Promise.all([
    loadOptions(db, url, store),
    loadLatest(db, url, store),
    loadSiteStats(db, url, Promise.resolve(store)),
  ]);
  return { options, latestReviews, stats };
}

export async function loadCatalogPublicData(db: D1Database, url: URL, cache = openCache()) {
  return { options: await loadOptions(db, url, await cache) };
}

export async function loadLandingData(db: D1Database, url: URL, cache = openCache()) {
  const store = await cache;
  const [latestReviews, stats, additions] = await Promise.all([
    loadLatest(db, url, store),
    loadSiteStats(db, url, Promise.resolve(store)),
    readHomeCache(store, url, "additions", async () => {
      const [courses, teachers] = await Promise.all([
        db.prepare(NEW_COURSES_SQL).all<NewCourse>(),
        db.prepare(NEW_TEACHERS_SQL).all<NewTeacher>(),
      ]);
      return { newCourses: courses.results, newTeachers: teachers.results };
    }),
  ]);
  return { latestReviews, stats, ...additions };
}

export async function invalidateHomeReviews(url: URL, cache = openCache()) {
  const store = await cache;
  if (!store) return;
  // Cache API deletion is local to this data center. Other data centers and
  // concurrent fills converge within 60s; detail pages and catalog counts are
  // uncached. Run only AFTER a successful write, before the redirect.
  await Promise.allSettled([store.delete(cacheRequest(url, "latest")), store.delete(cacheRequest(url, "stats"))]);
}

export async function invalidateCatalog(url: URL, cache = openCache()) {
  const store = await cache;
  if (!store) return;
  await Promise.allSettled(
    ["stats", "additions", "options"].map((key) => store.delete(cacheRequest(url, key as HomeKey))),
  );
}

// Public bounded candidates only. Caller-specific course exclusions and ranking
// happen after reading; no account, permission, review author or CSRF is cached.
export async function loadSimilarCandidates<T>(
  db: D1Database,
  url: URL,
  college: string,
  credits: number,
  cache = openCache(),
  now = Date.now,
): Promise<T[]> {
  const key: HomeKey = `similar/${encodeURIComponent(college)}/${credits}`;
  return readHomeCache<T[]>(
    await cache,
    url,
    key,
    async () =>
      (
        await db
          .prepare(`
    WITH candidates AS MATERIALIZED (
      SELECT lid, course_id, college, elective_type, credits, attribute, review_count
      FROM course_section INDEXED BY course_section_college_credits_idx
      WHERE college = ? AND credits = ? LIMIT 48
    )
    SELECT candidates.*, c.name FROM candidates JOIN courses AS c ON c.course_id = candidates.course_id
  `)
          .bind(college, credits)
          .all<T>()
      ).results,
    now,
  );
}
