import { error } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";
import { requestSession, sameOriginPost, trustedIssuer } from "./auth.js";
import type { AuthSession } from "./auth.js";
import type { LatestReview } from "./home-queries.js";
import { getBindings } from "./platform.js";
import { invalidateHomeReviews } from "./home-cache.js";

export const MODERATION_PAGE_SIZE = 20;
export type ReviewKind = "course" | "teacher";
type ModerationEvent = Pick<RequestEvent, "url" | "request" | "locals" | "cookies" | "platform">;
type AdminContext = {
  db: D1Database;
  actor: AuthSession;
  guard: string;
  guardValues: (string | number)[];
  issuer: string;
};

export function reviewKind(value: unknown): ReviewKind {
  if (value !== "course" && value !== "teacher") error(400, "请选择有效的点评类型。");
  return value;
}

export function targetId(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    error(400, "目标无效。");
  return Number(value);
}

export function moderationReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 500)
    error(400, "请填写操作理由（最多500字）。");
  return value.trim();
}

export async function requireAdmin(event: ModerationEvent): Promise<AdminContext> {
  const actor = await requestSession(event);
  if (!actor) error(401, "请先登录管理员账号。");
  if (!actor.isAdmin) error(403, "没有本站管理权限。");
  const env = getBindings(event.platform);
  if (!actor.sessionHash) error(403, "没有本站管理权限。");
  const issuer = trustedIssuer(env);
  // Every mutation repeats this authority check inside the batch transaction.
  // A revoked session, concurrent ban or changed verified binding cannot use
  // the earlier in-request authorization result to make a database change.
  const guard = `EXISTS (SELECT 1 FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>unixepoch() AND u.banned_at IS NULL
      AND u.issuer=? AND u.role='admin' AND u.role_expires_at>unixepoch())`;
  const guardValues = [actor.sessionHash, actor.userId, issuer];
  return { db: env.DB, actor, guard, guardValues, issuer };
}

export const MANAGEMENT_COOKIE = "lxk-management-mode";
export async function managementContext(event: ModerationEvent): Promise<AdminContext | null> {
  if (event.cookies?.get(MANAGEMENT_COOKIE) !== "1") return null;
  const session = await requestSession(event);
  return session?.isAdmin ? requireAdmin(event) : null;
}

export async function requireAdminPost(event: ModerationEvent, form: FormData): Promise<AdminContext> {
  const context = await requireAdmin(event);
  if (!sameOriginPost(event.request, event.url) || form.get("csrfToken") !== context.actor.csrfToken)
    error(403, "请求已失效，请刷新页面后重试。");
  return context;
}

export function moderationPaging(url: URL, total: number, key = "page") {
  const pages = Math.max(1, Math.ceil(total / MODERATION_PAGE_SIZE));
  const requested = Number(url.searchParams.get(key) ?? "1");
  const page = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, pages) : 1;
  return { page, pages, total, offset: (page - 1) * MODERATION_PAGE_SIZE, pageSize: MODERATION_PAGE_SIZE };
}

export type ReviewManagement = {
  authorId: number | null;
  authorName: string | null;
  bannedAt: number | null;
  canBan: boolean;
  deleted: boolean;
  deletedAt: number | null;
  reason: string | null;
};
export type AdminReview = LatestReview & {
  target_name: string;
  author_id: number | null;
  author_name: string | null;
  banned_at: number | null;
  canBan: boolean;
  reason: string | null;
  deleted_at: number | null;
  moderation: ReviewManagement;
};
type ReviewRow = Omit<AdminReview, "canBan" | "moderation"> & {
  author_issuer: string | null;
  author_role: string | null;
};
export type AuditEvent = {
  operation_id: string;
  actor_id: number;
  action: "archive_review" | "restore_review" | "ban_user" | "unban_user";
  review_type: ReviewKind | null;
  target_id: number;
  reason: string;
  created_at: number;
};

type ReviewScope = { kind?: ReviewKind; courseId?: string; lid?: string; teacherId?: number };
export function moderationFilters(url: URL) {
  const text = (key: string) => (url.searchParams.get(key) ?? "").trim().slice(0, 100);
  return {
    q: text("q"),
    target: text("target"),
    author: text("author"),
    kind: ["course", "teacher"].includes(text("type")) ? text("type") : "all",
    status: text("status") === "deleted" ? "deleted" : "active",
    ownership: ["known", "legacy"].includes(text("ownership")) ? text("ownership") : "all",
    banned: ["yes", "no"].includes(text("banned")) ? text("banned") : "all",
  };
}

export async function loadManagedReviews(context: AdminContext, url: URL, scope: ReviewScope = {}) {
  const { db, actor, issuer } = context;
  const filters = moderationFilters(url);
  const kind = scope.kind ?? filters.kind;
  const deleted = filters.status === "deleted";
  const values: (string | number)[] = [];
  const branches = (kind === "all" ? ["course", "teacher"] : [kind]).map((type) => {
    const course = type === "course";
    const table = deleted ? "moderation_review_archive" : course ? "course_reviews" : "teacher_reviews";
    const clauses: string[] = [];
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
    .first<{ total: number }>();
  const paging = moderationPaging(url, count?.total ?? 0);
  const direction = url.searchParams.get("sort") === "oldest" ? "ASC" : "DESC";
  const result = await db
    .prepare(
      `SELECT * FROM (${query}) ORDER BY ${deleted ? "deleted_at DESC" : `posted_at_local ${direction}`},review_type ASC,id ${direction} LIMIT ? OFFSET ?`,
    )
    .bind(...values, MODERATION_PAGE_SIZE, paging.offset)
    .all<ReviewRow>();
  const reviews: AdminReview[] = result.results.map(({ author_issuer, author_role, ...row }) => {
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

export async function loadModeration(context: AdminContext, url: URL) {
  const { db } = context;
  const list = await loadManagedReviews(context, url);
  const auditCount = await db.prepare("SELECT COUNT(*) AS total FROM moderation_events").first<{ total: number }>();
  const auditPaging = moderationPaging(url, auditCount?.total ?? 0, "auditPage");
  const audit = await db
    .prepare(
      "SELECT operation_id, actor_id, action, review_type, target_id, reason, created_at FROM moderation_events ORDER BY created_at DESC, operation_id LIMIT ? OFFSET ?",
    )
    .bind(MODERATION_PAGE_SIZE, auditPaging.offset)
    .all<AuditEvent>();
  return { ...list, audit: audit.results, auditPaging };
}

export async function archiveReview(
  context: AdminContext,
  kind: ReviewKind,
  id: number,
  reason: string,
  url: URL,
): Promise<boolean> {
  const { db, actor, guard, guardValues } = context;
  const table = kind === "course" ? "course_reviews" : "teacher_reviews";
  const operation = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const result = await db.batch([
    db
      .prepare(`INSERT INTO moderation_review_archive
      (review_type,review_id,lid,teacher_id,title,content,posted_at_local,author_id,is_anonymous,public_username,public_avatar_url,deleted_by,deleted_at,reason,operation_id)
      SELECT ?,id,${kind === "course" ? "lid,NULL" : "NULL,teacher_id"},title,content,posted_at_local,author_id,is_anonymous,public_username,public_avatar_url,?,?,?,?
      FROM ${table} WHERE id=? AND ${guard}`)
      .bind(kind, actor.userId, now, reason, operation, id, ...guardValues),
    db
      .prepare(
        `DELETE FROM ${table} WHERE id=? AND EXISTS (SELECT 1 FROM moderation_review_archive WHERE operation_id=?)`,
      )
      .bind(id, operation),
    db
      .prepare(`INSERT INTO moderation_events (operation_id,actor_id,action,review_type,target_id,reason,created_at)
      SELECT ?,?,'archive_review',?,?,?,? WHERE EXISTS (SELECT 1 FROM moderation_review_archive WHERE operation_id=?)`)
      .bind(operation, actor.userId, kind, id, reason, now, operation),
  ]);
  const changed = result[0].meta.changes > 0;
  if (changed) await invalidateHomeReviews(url);
  return changed;
}

export async function restoreReview(
  context: AdminContext,
  kind: ReviewKind,
  id: number,
  reason: string,
  url: URL,
): Promise<boolean> {
  const { db, actor, guard, guardValues } = context;
  const table = kind === "course" ? "course_reviews" : "teacher_reviews";
  const reference = kind === "course" ? "lid" : "teacher_id";
  const operation = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const result = await db.batch([
    // No REPLACE/IGNORE: an unexpected collision aborts the entire batch and
    // keeps the original archive untouched rather than overwriting a review.
    db
      .prepare(`INSERT INTO ${table} (id,${reference},title,content,posted_at_local,author_id,is_anonymous,public_username,public_avatar_url)
      SELECT review_id,${reference},title,content,posted_at_local,author_id,is_anonymous,public_username,public_avatar_url FROM moderation_review_archive
      WHERE review_type=? AND review_id=? AND ${guard}`)
      .bind(kind, id, ...guardValues),
    db
      .prepare(`INSERT INTO moderation_events (operation_id,actor_id,action,review_type,target_id,reason,created_at)
      SELECT ?,?,'restore_review',?,?,?,? WHERE EXISTS (SELECT 1 FROM moderation_review_archive WHERE review_type=? AND review_id=?)
      AND ${guard} AND EXISTS (SELECT 1 FROM ${table} WHERE id=?)`)
      .bind(operation, actor.userId, kind, id, reason, now, kind, id, ...guardValues, id),
    db
      .prepare(`DELETE FROM moderation_review_archive WHERE review_type=? AND review_id=?
      AND EXISTS (SELECT 1 FROM moderation_events WHERE operation_id=?)`)
      .bind(kind, id, operation),
  ]);
  const changed = result[0].meta.changes > 0;
  if (changed) await invalidateHomeReviews(url);
  return changed;
}

export async function setUserBan(context: AdminContext, id: number, banned: boolean, reason: string): Promise<boolean> {
  const { db, actor, guard, guardValues, issuer } = context;
  if (id === actor.userId) error(400, "不能封禁或修改自己的封禁状态。");
  const target = await db
    .prepare("SELECT id,issuer,role FROM auth_users WHERE id=?")
    .bind(id)
    .first<{ id: number; issuer: string; role: string }>();
  if (!target) error(404, "账号不存在；历史匿名点评没有可封禁的作者。");
  if (target.issuer === issuer && target.role === "admin") error(400, "不能封禁或修改其他管理员的封禁状态。");
  const operation = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const targetGuard = `NOT EXISTS (SELECT 1 FROM auth_users protected WHERE protected.id=auth_users.id AND protected.issuer=?
    AND protected.role='admin')`;
  const result = await db.batch([
    db
      .prepare(`UPDATE auth_users SET banned_at=?,ban_reason=? WHERE id=? AND ${banned ? "banned_at IS NULL" : "banned_at IS NOT NULL"}
      AND id<>? AND ${targetGuard} AND ${guard}`)
      .bind(banned ? now : null, banned ? reason : null, id, actor.userId, issuer, ...guardValues),
    // SQLite changes() refers to the immediately preceding UPDATE. A ban also
    // revokes sessions through its trigger in that same transaction.
    db
      .prepare(`INSERT INTO moderation_events (operation_id,actor_id,action,review_type,target_id,reason,created_at)
      SELECT ?,?,?,NULL,?,?,? WHERE changes()>0`)
      .bind(operation, actor.userId, banned ? "ban_user" : "unban_user", id, reason, now),
  ]);
  return result[0].meta.changes > 0;
}
