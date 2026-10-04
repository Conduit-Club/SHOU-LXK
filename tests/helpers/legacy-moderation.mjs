// Before the 2026-10-04 read-budget fix. Reference SQL only; never called by the application.
const { moderationFilters, moderationPaging, MODERATION_PAGE_SIZE } =
  await import("../../src/lib/server/moderation.ts");

export async function legacyManagedReviews(context, url, scope = {}) {
  const { db, actor, issuer } = context;
  const filters = moderationFilters(url);
  const kind = scope.kind ?? filters.kind;
  const deleted = filters.status === "deleted";
  const values = [];
  const branches = (kind === "all" ? ["course", "teacher"] : [kind]).map((type) => {
    const course = type === "course";
    const table = deleted ? "moderation_review_archive" : course ? "course_reviews" : "teacher_reviews";
    const clauses = [];
    if (deleted) {
      clauses.push("r.review_type=?");
      values.push(type);
    }
    if (scope.courseId) {
      clauses.push("cs.course_id=?");
      values.push(scope.courseId);
    }
    if (scope.lid) {
      clauses.push("r.lid=?");
      values.push(scope.lid);
    }
    if (scope.teacherId) {
      clauses.push("r.teacher_id=?");
      values.push(scope.teacherId);
    }
    if (filters.q) {
      clauses.push("(instr(lower(r.title),lower(?))>0 OR instr(lower(r.content),lower(?))>0)");
      values.push(filters.q, filters.q);
    }
    if (filters.target) {
      clauses.push(
        course
          ? "(instr(lower(c.name),lower(?))>0 OR instr(lower(c.course_id),lower(?))>0 OR r.lid=?)"
          : "instr(lower(t.name),lower(?))>0",
      );
      values.push(...(course ? [filters.target, filters.target, filters.target] : [filters.target]));
    }
    if (filters.author) {
      clauses.push("(instr(lower(COALESCE(u.username,'')),lower(?))>0 OR CAST(r.author_id AS TEXT)=?)");
      values.push(filters.author, filters.author.replace(/^#/, ""));
    }
    if (filters.ownership !== "all") clauses.push(`r.author_id IS ${filters.ownership === "known" ? "NOT " : ""}NULL`);
    if (filters.banned !== "all") clauses.push(`u.banned_at IS ${filters.banned === "yes" ? "NOT " : ""}NULL`);
    return `SELECT r.${deleted ? "review_id" : "id"} AS id, '${type}' AS review_type,
      ${course ? "r.lid, c.course_id, c.name AS course_name, NULL AS teacher_id, NULL AS teacher_name, c.name" : "NULL AS lid, NULL AS course_id, NULL AS course_name, r.teacher_id, t.name AS teacher_name, t.name"} AS target_name,
      r.title,r.content,r.posted_at_local,
      CASE WHEN r.is_anonymous=0 THEN COALESCE(r.public_username,'匿名用户') ELSE '匿名用户' END AS display_name,
      CASE WHEN r.is_anonymous=0 THEN r.public_avatar_url ELSE NULL END AS avatar_url,
      r.author_id,COALESCE(u.username,u.name) AS author_name,u.banned_at,u.issuer AS author_issuer,u.role AS author_role,
      ${deleted ? "r.reason,r.deleted_at" : "NULL AS reason,NULL AS deleted_at"}
      FROM ${table} r ${course ? "JOIN course_section cs ON cs.lid=r.lid JOIN courses c ON c.course_id=cs.course_id" : "JOIN teachers t ON t.id=r.teacher_id"}
      LEFT JOIN auth_users u ON u.id=r.author_id ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}`;
  });
  const query = branches.join(" UNION ALL ");
  const count = await db
    .prepare(`SELECT COUNT(*) AS total FROM (${query})`)
    .bind(...values)
    .first();
  const paging = moderationPaging(url, count?.total ?? 0);
  const direction = url.searchParams.get("sort") === "oldest" ? "ASC" : "DESC";
  const result = await db
    .prepare(
      `SELECT * FROM (${query}) ORDER BY ${deleted ? "deleted_at DESC" : `posted_at_local ${direction}`},review_type ASC,id ${direction} LIMIT ? OFFSET ?`,
    )
    .bind(...values, MODERATION_PAGE_SIZE, paging.offset)
    .all();
  const reviews = result.results.map(({ author_issuer, author_role, ...row }) => {
    const canBan =
      row.author_id !== null &&
      row.author_id !== actor.userId &&
      !(author_issuer === issuer && author_role === "admin");
    return {
      ...row,
      canBan,
      moderation: {
        authorId: row.author_id,
        authorName: row.author_name,
        bannedAt: row.banned_at,
        canBan,
        deleted,
        deletedAt: row.deleted_at,
        reason: row.reason,
      },
    };
  });
  return { kind, deleted, ...paging, reviews, filters };
}
