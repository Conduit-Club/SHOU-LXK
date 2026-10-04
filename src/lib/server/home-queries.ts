import { publicReviewProjection } from "./public-review.js";
import type { PublicReviewIdentity } from "./public-review.js";
export const PAGE_SIZE = 12;

export type SectionCard = {
  lid: string;
  course_id: string;
  name: string;
  college: string;
  elective_type: string;
  credits: number;
  review_count: number;
};

export type LatestReview = PublicReviewIdentity & {
  id: number;
  review_type: "course" | "teacher";
  lid: string | null;
  course_id: string | null;
  course_name: string | null;
  teacher_id: number | null;
  teacher_name: string | null;
  title: string;
  content: string;
  posted_at_local: string;
};

export type SiteStats = { courses: number; sections: number; reviews: number; teachers: number };
export type NewCourse = { course_id: string; name: string };
export type NewTeacher = { id: number; name: string };
// Imported catalogs have no creation timestamps: show the last recorded rows.
export const NEW_COURSES_SQL = "SELECT course_id, name FROM courses ORDER BY rowid DESC LIMIT 5";
export const NEW_TEACHERS_SQL = "SELECT id, name FROM teachers ORDER BY id DESC LIMIT 5";
export type FilterOptions = { colleges: string[]; electiveTypes: string[]; attributes: string[]; credits: number[] };

export function reviewFeedSql(predicate = "", branchLimit = "5", finalLimit = "5") {
  return `
  WITH course_latest AS (
    SELECT id, lid, title, content, posted_at_local, ${publicReviewProjection()}
    FROM course_reviews ${predicate}
    ORDER BY posted_at_local DESC, id DESC LIMIT ${branchLimit}
  ), teacher_latest AS (
    SELECT id, teacher_id, title, content, posted_at_local, ${publicReviewProjection()}
    FROM teacher_reviews ${predicate}
    ORDER BY posted_at_local DESC, id DESC LIMIT ${branchLimit}
  )
  SELECT id, review_type, lid, course_id, course_name, teacher_id, teacher_name, title, content, posted_at_local, display_name, avatar_url
  FROM (
    SELECT r.id, 'course' AS review_type, r.lid, c.course_id, c.name AS course_name,
      NULL AS teacher_id, NULL AS teacher_name, r.title, r.content, r.posted_at_local, r.display_name, r.avatar_url
    FROM course_latest AS r
    CROSS JOIN course_section AS cs ON cs.lid = r.lid
    CROSS JOIN courses AS c ON c.course_id = cs.course_id
    UNION ALL
    SELECT r.id, 'teacher' AS review_type, NULL AS lid, NULL AS course_id, NULL AS course_name,
      t.id AS teacher_id, t.name AS teacher_name, r.title, r.content, r.posted_at_local, r.display_name, r.avatar_url
    FROM teacher_latest AS r
    CROSS JOIN teachers AS t ON t.id = r.teacher_id
  )
  ORDER BY posted_at_local DESC, review_type ASC, id DESC
  LIMIT ${finalLimit}
`;
}

export const LATEST_REVIEWS_SQL = reviewFeedSql();

export const SITE_STATS_SQL = "SELECT courses, sections, reviews, teachers FROM site_stats WHERE id = 1";

export const OPTION_SQL = {
  colleges: "SELECT value FROM category_options WHERE category_type = 'college' AND value <> 'N/A' ORDER BY position",
  electiveTypes:
    "SELECT value FROM category_options WHERE category_type = 'lessonType' AND value <> 'N/A' ORDER BY position",
  attributes: "SELECT DISTINCT trim(attribute) AS value FROM course_section WHERE trim(attribute) <> '' ORDER BY value",
  credits: "SELECT DISTINCT credits FROM course_section ORDER BY credits",
};

const textFilter = (value: string | null) => (value ?? "").trim().slice(0, 100);

export function parseHomeFilters(params: URLSearchParams) {
  const filters = {
    q: textFilter(params.get("q")),
    teacher: textFilter(params.get("teacher")),
    college: textFilter(params.get("college")),
    electiveType: textFilter(params.get("electiveType")),
    attribute: textFilter(params.get("attribute")),
    credits: textFilter(params.get("credits")),
    minReviews: textFilter(params.get("minReviews")),
    sort: textFilter(params.get("sort")),
  };
  const credit = /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(filters.credits) ? Number(filters.credits) : null;
  const minReviews = /^\d+$/.test(filters.minReviews) ? Number(filters.minReviews) : null;
  filters.sort = ["reviews", "name", "credits"].includes(filters.sort) ? filters.sort : "reviews";
  filters.credits = credit !== null && Number.isFinite(credit) && credit >= 0 && credit <= Number.MAX_SAFE_INTEGER ? String(credit) : "";
  filters.minReviews =
    minReviews !== null && Number.isSafeInteger(minReviews) && minReviews > 0 ? String(minReviews) : "";
  return filters;
}

export function catalogQueries(filters: ReturnType<typeof parseHomeFilters>) {
  const clauses: string[] = [];
  const values: (string | number)[] = [];
  const hasSectionFilter = Boolean(
    filters.college || filters.electiveType || filters.attribute || filters.credits || filters.minReviews,
  );
  const countNeedsCourse = Boolean(filters.q && (hasSectionFilter || filters.teacher));
  let listSearch = "";
  if (filters.q) {
    // Preserve case-insensitive substring matching (including literal % and _).
    // Scan course names once, not once for every matching section.
    const courseSearch = "(instr(lower(c.name), lower(?)) > 0 OR instr(lower(c.course_id), lower(?)) > 0)";
    const courseIds = `cs.course_id IN (
      SELECT course_id FROM courses
      WHERE instr(lower(name), lower(?)) > 0 OR instr(lower(course_id), lower(?)) > 0
    )`;
    clauses.push(countNeedsCourse ? courseSearch : courseIds);
    // For a standalone substring search, materialize the matches once per SQL
    // statement. This bounds rare/empty searches and avoids a Bloom-filter scan
    // plus repeated name checks while traversing every section in rank order.
    listSearch = countNeedsCourse ? courseSearch : courseIds;
    values.push(filters.q, filters.q);
  }
  if (filters.teacher) {
    // Uncorrelated membership avoids a teacher lookup for every section and
    // prevents duplicate sections when several co-teachers match the name.
    clauses.push(
      hasSectionFilter
        ? `EXISTS (SELECT 1 FROM course_section_teachers AS st JOIN teachers AS t ON t.id = st.teacher_id
          WHERE st.lid = cs.lid AND instr(lower(t.name), lower(?)) > 0)`
        : `cs.lid IN (
      SELECT st.lid FROM teachers AS t
      CROSS JOIN course_section_teachers AS st ON st.teacher_id = t.id
      WHERE instr(lower(t.name), lower(?)) > 0
    )`,
    );
    values.push(filters.teacher);
  }
  if (filters.college) {
    clauses.push("cs.college = ?");
    values.push(filters.college);
  }
  if (filters.electiveType) {
    clauses.push("cs.elective_type = ?");
    values.push(filters.electiveType);
  }
  if (filters.attribute) {
    clauses.push("trim(cs.attribute) = ?");
    values.push(filters.attribute);
  }
  if (filters.credits) {
    clauses.push("cs.credits = ?");
    values.push(Number(filters.credits));
  }
  if (filters.minReviews) {
    clauses.push("cs.review_count >= ?");
    values.push(Number(filters.minReviews));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const listClauses = filters.q ? [listSearch, ...clauses.slice(1)] : clauses;
  const listWhere = listClauses.length ? `WHERE ${listClauses.join(" AND ")}` : "";
  const orderBy = {
    reviews: "cs.review_count DESC, c.name COLLATE NOCASE ASC",
    name: "c.name COLLATE NOCASE ASC",
    credits: "cs.credits DESC, c.name COLLATE NOCASE ASC",
  }[filters.sort as "reviews" | "name" | "credits"];
  return {
    values,
    filtered: clauses.length > 0,
    // FK integrity allows counts without display joins. A combined name search
    // joins only its candidate sections instead of materializing all course IDs.
    count: clauses.length
      ? `SELECT COUNT(*) AS total FROM course_section AS cs ${countNeedsCourse ? "JOIN courses AS c ON c.course_id = cs.course_id" : ""} ${where}`
      : "SELECT sections AS total FROM site_stats WHERE id = 1",
    list: `SELECT cs.lid, c.course_id, c.name, cs.college, cs.elective_type, cs.credits, cs.review_count
      FROM course_section AS cs ${filters.sort === "reviews" && !filters.q ? "CROSS JOIN" : "JOIN"} courses AS c ON c.course_id = cs.course_id
      ${listWhere}
      ORDER BY ${orderBy}, c.course_id, cs.lid LIMIT ? OFFSET ?`,
  };
}
