import { error } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";
import { adminEmailHashes, requestSession, sameOriginPost, trustedIssuer } from "./auth.js";
import type { AuthSession } from "./auth.js";
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
  hashes: string[];
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
  const hashes = await adminEmailHashes(env);
  if (!hashes.length || !actor.sessionHash) error(403, "没有本站管理权限。");
  const issuer = trustedIssuer(env);
  // Every mutation repeats this authority check inside the batch transaction.
  // A revoked session, concurrent ban or changed verified binding cannot use
  // the earlier in-request authorization result to make a database change.
  const guard = `EXISTS (SELECT 1 FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>unixepoch() AND u.banned_at IS NULL
      AND u.issuer=? AND u.verified_email_hash IN (${hashes.map(() => "?").join(",")}))`;
  const guardValues = [actor.sessionHash, actor.userId, issuer, ...hashes];
  return { db: env.DB, actor, guard, guardValues, hashes, issuer };
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

export type AdminReview = {
  id: number;
  title: string;
  content: string;
  posted_at_local: string;
  lid: string | null;
  teacher_id: number | null;
  target_name: string;
  author_id: number | null;
  author_name: string | null;
  banned_at: number | null;
  canBan: boolean;
  reason: string | null;
  deleted_at: number | null;
};
type ReviewRow = Omit<AdminReview, "canBan"> & { author_issuer: string | null; author_email_hash: string | null };
export type AuditEvent = {
  operation_id: string;
  actor_id: number;
  action: "archive_review" | "restore_review" | "ban_user" | "unban_user";
  review_type: ReviewKind | null;
  target_id: number;
  reason: string;
  created_at: number;
};

export async function loadModeration(context: AdminContext, url: URL) {
  const { db, actor, hashes, issuer } = context;
  const kind = url.searchParams.get("type") === "teacher" ? "teacher" : "course";
  const deleted = url.searchParams.get("status") === "deleted";
  const table = kind === "course" ? "course_reviews" : "teacher_reviews";
  const count = await db
    .prepare(
      deleted
        ? "SELECT COUNT(*) AS total FROM moderation_review_archive WHERE review_type=?"
        : `SELECT COUNT(*) AS total FROM ${table}`,
    )
    .bind(...(deleted ? [kind] : []))
    .first<{ total: number }>();
  const paging = moderationPaging(url, count?.total ?? 0);
  const select = deleted
    ? `SELECT review_id AS id, lid, teacher_id, title, content, posted_at_local, author_id, reason, deleted_at
       FROM moderation_review_archive WHERE review_type=? ORDER BY deleted_at DESC, review_id DESC LIMIT ? OFFSET ?`
    : `SELECT id, ${kind === "course" ? "lid, NULL AS teacher_id" : "NULL AS lid, teacher_id"}, title, content, posted_at_local, author_id,
       NULL AS reason, NULL AS deleted_at FROM ${table} ORDER BY posted_at_local DESC, id DESC LIMIT ? OFFSET ?`;
  const targetJoin =
    kind === "course"
      ? "LEFT JOIN course_section cs ON cs.lid=r.lid LEFT JOIN courses c ON c.course_id=cs.course_id"
      : "LEFT JOIN teachers t ON t.id=r.teacher_id";
  const result = await db
    .prepare(`WITH items AS MATERIALIZED (${select}) SELECT r.*, ${kind === "course" ? "c.name" : "t.name"} AS target_name,
    u.name AS author_name, u.banned_at, u.issuer AS author_issuer, u.verified_email_hash AS author_email_hash
    FROM items r ${targetJoin} LEFT JOIN auth_users u ON u.id=r.author_id
    ORDER BY ${deleted ? "r.deleted_at" : "r.posted_at_local"} DESC, r.id DESC`)
    .bind(...(deleted ? [kind] : []), MODERATION_PAGE_SIZE, paging.offset)
    .all<ReviewRow>();
  const reviews: AdminReview[] = result.results.map(({ author_issuer, author_email_hash, ...row }) => ({
    ...row,
    canBan:
      row.author_id !== null &&
      row.author_id !== actor.userId &&
      !(author_issuer === issuer && !!author_email_hash && hashes.includes(author_email_hash)),
  }));
  const auditCount = await db.prepare("SELECT COUNT(*) AS total FROM moderation_events").first<{ total: number }>();
  const auditPaging = moderationPaging(url, auditCount?.total ?? 0, "auditPage");
  const audit = await db
    .prepare(
      "SELECT operation_id, actor_id, action, review_type, target_id, reason, created_at FROM moderation_events ORDER BY created_at DESC, operation_id LIMIT ? OFFSET ?",
    )
    .bind(MODERATION_PAGE_SIZE, auditPaging.offset)
    .all<AuditEvent>();
  return { kind, deleted, ...paging, reviews, audit: audit.results, auditPaging };
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
      (review_type,review_id,lid,teacher_id,title,content,posted_at_local,author_id,deleted_by,deleted_at,reason,operation_id)
      SELECT ?,id,${kind === "course" ? "lid,NULL" : "NULL,teacher_id"},title,content,posted_at_local,author_id,?,?,?,?
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
      .prepare(`INSERT INTO ${table} (id,${reference},title,content,posted_at_local,author_id)
      SELECT review_id,${reference},title,content,posted_at_local,author_id FROM moderation_review_archive
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
  const { db, actor, guard, guardValues, hashes, issuer } = context;
  if (id === actor.userId) error(400, "不能封禁或修改自己的封禁状态。");
  const target = await db
    .prepare("SELECT id,issuer,verified_email_hash FROM auth_users WHERE id=?")
    .bind(id)
    .first<{ id: number; issuer: string; verified_email_hash: string | null }>();
  if (!target) error(404, "账号不存在；历史匿名点评没有可封禁的作者。");
  if (target.issuer === issuer && target.verified_email_hash && hashes.includes(target.verified_email_hash))
    error(400, "不能封禁或修改其他管理员的封禁状态。");
  const operation = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const targetGuard = `NOT EXISTS (SELECT 1 FROM auth_users protected WHERE protected.id=auth_users.id AND protected.issuer=?
    AND protected.verified_email_hash IN (${hashes.map(() => "?").join(",")}))`;
  const result = await db.batch([
    db
      .prepare(`UPDATE auth_users SET banned_at=?,ban_reason=? WHERE id=? AND ${banned ? "banned_at IS NULL" : "banned_at IS NOT NULL"}
      AND id<>? AND ${targetGuard} AND ${guard}`)
      .bind(banned ? now : null, banned ? reason : null, id, actor.userId, issuer, ...hashes, ...guardValues),
    // SQLite changes() refers to the immediately preceding UPDATE. A ban also
    // revokes sessions through its trigger in that same transaction.
    db
      .prepare(`INSERT INTO moderation_events (operation_id,actor_id,action,review_type,target_id,reason,created_at)
      SELECT ?,?,?,NULL,?,?,? WHERE changes()>0`)
      .bind(operation, actor.userId, banned ? "ban_user" : "unban_user", id, reason, now),
  ]);
  return result[0].meta.changes > 0;
}
