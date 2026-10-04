import { error } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";
import { requestSession, sameOriginPost, trustedIssuer } from "./auth.js";
import { getBindings } from "./platform.js";
import { invalidateCatalog } from "./home-cache.js";
import { moderationPaging } from "./moderation.js";
import type { requireAdmin } from "./moderation.js";
import { DIRECT_CATALOG_LIMITS } from "../catalog.js";
import type { CatalogDraft, CatalogKind, CatalogSubmission } from "../catalog.js";

type CatalogEvent = Pick<RequestEvent, "platform" | "url" | "cookies" | "locals" | "request">;
type AdminContext = Awaited<ReturnType<typeof requireAdmin>>;
type SubmitterContext = Awaited<ReturnType<typeof requireSubmitter>>;
const DIRECT_REASON = "管理员直接收录";
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const COLUMNS = `id,kind,name,course_id,college,elective_type,credits,lid,note,status,created_at,
  reviewed_at,reviewed_by,reason,published_course_id,published_lid,published_teacher_id,approved_payload`;

export function submissionId(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) error(400, "提交编号无效，请刷新后重试。");
  return value;
}

function field(form: FormData, key: string, label: string, max: number, required = true): string {
  const raw = form.get(key);
  const text = typeof raw === "string" ? raw.normalize("NFKC").trim().replace(/\s+/g, " ") : "";
  if (
    (required && !text) ||
    text.length > max ||
    Array.from(text).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    error(400, `请填写${label}（最多${max}字）。`);
  return text;
}

export function parseCatalogDraft(form: FormData, forcedKind?: CatalogKind): CatalogDraft {
  const kind = forcedKind ?? form.get("kind");
  if (kind !== "course" && kind !== "teacher") error(400, "请选择课程或老师。");
  const name = field(form, "name", kind === "course" ? "课程名称" : "老师姓名", 100);
  const rawNote = form.get("note");
  const note = typeof rawNote === "string" ? rawNote.trim() : "";
  if (note.length > 1000 || note.includes(String.fromCharCode(0)) || note.includes(String.fromCharCode(127)))
    error(400, "补充说明最多1000字。");
  if (kind === "teacher")
    return { kind, name, courseId: null, college: null, electiveType: null, credits: null, lid: null, note };
  const courseId = field(form, "courseId", "课程号", 40).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,39}$/.test(courseId)) error(400, "课程号仅支持字母、数字、点、下划线和短横线。");
  const college = field(form, "college", "开课学院", 100);
  const electiveType = field(form, "electiveType", "课程类型", 60);
  const creditsText = field(form, "credits", "学分", 32);
  const credits = Number(creditsText);
  if (!/^(?:\d{1,2}(?:\.\d+)?|\.\d+)$/.test(creditsText) || !Number.isFinite(credits) || credits > 30)
    error(400, "学分须为0到30的数字，可填写0.5、1.5等小数。请核实后填写。");
  const lid = field(form, "lid", "班级号", 60, false);
  if (lid && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/.test(lid) || /^community-/i.test(lid)))
    error(400, "班级号仅支持字母、数字、点、下划线和短横线，不能使用保留的收录编号。");
  return { kind, name, courseId, college, electiveType, credits, lid: lid || null, note };
}

export async function requireSubmitter(event: CatalogEvent, form?: FormData) {
  const actor = await requestSession(event);
  if (!actor) error(401, "请先登录后提交目录补充。");
  if (!actor.username) error(401, "请重新登录并设置统一账号用户名后提交。");
  if (form && (!sameOriginPost(event.request, event.url) || form.get("csrfToken") !== actor.csrfToken))
    error(403, "请求已失效，请刷新页面后重试。");
  const env = getBindings(event.platform);
  const guard = `EXISTS (SELECT 1 FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>unixepoch() AND u.banned_at IS NULL
      AND u.issuer=? AND u.username=?)`;
  return {
    db: env.DB,
    actor,
    guard,
    guardValues: [actor.sessionHash, actor.userId, trustedIssuer(env), actor.username],
  };
}

function catalogTarget(draft: CatalogDraft) {
  // Match SQLite NOCASE: fold ASCII consistently, preserve non-ASCII names.
  const key =
    draft.kind === "course"
      ? `course:${draft.courseId}`
      : `teacher:${draft.name.replace(/[A-Z]/g, (letter) => letter.toLowerCase())}`;
  const official =
    draft.kind === "course"
      ? "NOT EXISTS (SELECT 1 FROM courses WHERE course_id=? COLLATE NOCASE)"
      : "NOT EXISTS (SELECT 1 FROM teachers WHERE name=? COLLATE NOCASE)";
  return { key, official };
}

function catalogInsert(context: SubmitterContext, id: string, draft: CatalogDraft, admin?: AdminContext) {
  const { db, actor } = context;
  const { key, official } = catalogTarget(draft);
  // Only server-approved self-review records count towards the maintenance quota.
  // Direct publication neither fills pending slots nor consumes ordinary submission limits.
  const directRecord = "(status='approved' AND reviewed_by=author_id AND reason=?)";
  const quotaFilter = admin ? directRecord : `NOT ${directRecord}`;
  return db
    .prepare(`INSERT INTO catalog_submissions
    (id,author_id,kind,target_key,name,course_id,college,elective_type,credits,lid,note,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,unixepoch() WHERE ${context.guard} ${admin ? `AND ${admin.guard}` : ""} AND ${official}
      AND NOT EXISTS (SELECT 1 FROM catalog_submissions WHERE target_key=? AND status='pending')
      AND (SELECT COUNT(*) FROM catalog_submissions WHERE author_id=? AND created_at>unixepoch()-3600 AND ${quotaFilter})<?
      AND (SELECT COUNT(*) FROM catalog_submissions WHERE author_id=? AND created_at>unixepoch()-86400 AND ${quotaFilter})<?
      ${admin ? "" : "AND (SELECT COUNT(*) FROM catalog_submissions WHERE author_id=? AND status='pending')<10"}
    ON CONFLICT DO NOTHING`)
    .bind(
      id,
      actor.userId,
      draft.kind,
      key,
      draft.name,
      draft.courseId,
      draft.college,
      draft.electiveType,
      draft.credits,
      draft.lid,
      draft.note,
      ...context.guardValues,
      ...(admin?.guardValues ?? []),
      draft.courseId ?? draft.name,
      key,
      actor.userId,
      DIRECT_REASON,
      admin ? DIRECT_CATALOG_LIMITS.hourly : 5,
      actor.userId,
      DIRECT_REASON,
      admin ? DIRECT_CATALOG_LIMITS.daily : 20,
      ...(admin ? [] : [actor.userId]),
    );
}

async function existingSubmission(context: SubmitterContext, id: string, direct = false) {
  const prior = await context.db
    .prepare("SELECT author_id,status FROM catalog_submissions WHERE id=?")
    .bind(id)
    .first<{ author_id: number; status: string }>();
  if (!prior) return false;
  if (prior.author_id !== context.actor.userId) error(409, "提交编号已被使用，请刷新后重试。");
  if (direct && prior.status !== "approved") error(409, "此补充已提交，请从目录审核查看处理状态，或刷新后重新填写。");
  return true;
}

async function submissionFailure(
  context: SubmitterContext,
  draft: CatalogDraft,
  admin?: AdminContext,
  atomicFailure = false,
): Promise<never> {
  const { db, guard, guardValues } = admin ?? context;
  const authorized = await db
    .prepare(`SELECT ${guard} AS ok`)
    .bind(...guardValues)
    .first<{ ok: number }>();
  if (!authorized?.ok) {
    if (admin) error(403, "管理员权限已失效，请重新验证后直接收录；本次没有保存为待审补充。");
    error(401, "登录状态已失效，请重新登录后提交。");
  }
  const { key, official } = catalogTarget(draft);
  const exists = await db
    .prepare(`SELECT NOT (${official}) AS official,
    EXISTS (SELECT 1 FROM catalog_submissions WHERE target_key=? AND status='pending') AS pending`)
    .bind(draft.courseId ?? draft.name, key)
    .first<{ official: number; pending: number }>();
  if (exists?.official) error(409, "此课程号或老师已在目录中，请先搜索现有条目。");
  if (exists?.pending) error(409, "此课程号或老师已有待审补充，请勿重复提交。");
  if (admin && draft.lid) {
    const section = await db.prepare("SELECT 1 AS found FROM course_section WHERE lid=?").bind(draft.lid).first();
    if (section) error(409, "此班级编号已在目录中，请核实编号后重试。");
  }
  if (atomicFailure) error(409, "直接收录未完成，权限或目录信息发生变化，请刷新核实后重试。本次没有保存为待审补充。");
  if (admin)
    error(
      429,
      `直接收录过于频繁：每小时最多${DIRECT_CATALOG_LIMITS.hourly}条、每天${DIRECT_CATALOG_LIMITS.daily}条。请稍后再试。`,
    );
  error(429, "提交过于频繁：每小时最多5条、每天20条，同时待审最多10条。请稍后再试。");
}

export async function submitCatalog(context: SubmitterContext, id: string, draft: CatalogDraft) {
  // The form's UUID makes network retries idempotent, without accepting any client role/owner/state.
  if (await existingSubmission(context, id)) return false;
  const result = await catalogInsert(context, id, draft).run();
  if (result.meta.changes) return true;
  if (await existingSubmission(context, id)) return false;
  return submissionFailure(context, draft);
}

export async function loadOwnSubmission(context: SubmitterContext, id: string) {
  return context.db
    .prepare(`SELECT ${COLUMNS} FROM catalog_submissions WHERE id=? AND author_id=?`)
    .bind(submissionId(id), context.actor.userId)
    .first<CatalogSubmission>();
}

export async function loadOwnSubmissions(context: SubmitterContext, url: URL) {
  const { db, actor } = context;
  const count = await db
    .prepare("SELECT COUNT(*) AS total FROM catalog_submissions WHERE author_id=?")
    .bind(actor.userId)
    .first<{ total: number }>();
  const paging = moderationPaging(url, count?.total ?? 0);
  const list = await db
    .prepare(
      `SELECT ${COLUMNS} FROM catalog_submissions WHERE author_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,
    )
    .bind(actor.userId, paging.pageSize, paging.offset)
    .all<CatalogSubmission>();
  return { submissions: list.results, ...paging };
}

export async function loadCatalogQueue(context: AdminContext, url: URL) {
  const statusParam = url.searchParams.get("status");
  const status = statusParam === "approved" || statusParam === "rejected" ? statusParam : "pending";
  const kindParam = url.searchParams.get("kind");
  const kind = kindParam === "course" || kindParam === "teacher" ? kindParam : "all";
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const clauses = ["p.status=?"];
  const values: (string | number)[] = [status];
  if (kind !== "all") {
    clauses.push("p.kind=?");
    values.push(kind);
  }
  if (q) {
    clauses.push("(instr(lower(p.name),lower(?))>0 OR instr(lower(COALESCE(p.course_id,'')),lower(?))>0)");
    values.push(q, q);
  }
  const where = clauses.join(" AND ");
  const count = await context.db
    .prepare(`SELECT COUNT(*) AS total FROM catalog_submissions p WHERE ${where}`)
    .bind(...values)
    .first<{ total: number }>();
  const paging = moderationPaging(url, count?.total ?? 0);
  const list = await context.db
    .prepare(`SELECT ${COLUMNS.split(",")
      .map((column) => `p.${column.trim()}`)
      .join(",")},
    p.author_id,u.username AS author_name FROM catalog_submissions p LEFT JOIN auth_users u ON u.id=p.author_id
    WHERE ${where} ORDER BY p.created_at,p.id LIMIT ? OFFSET ?`)
    .bind(...values, paging.pageSize, paging.offset)
    .all<CatalogSubmission & { author_id: number; author_name: string | null }>();
  return { submissions: list.results, filters: { status, kind, q }, ...paging };
}

function catalogDecisionStatements(
  context: AdminContext,
  id: string,
  approved: boolean,
  reason: string,
  draft: CatalogDraft | null,
  onlyNewSubmission = false,
) {
  const { db, actor, guard, guardValues } = context;
  const operation = crypto.randomUUID();
  const publishedLid = draft?.kind === "course" ? (draft.lid ?? `community-${id}`) : null;
  const payload = draft ? JSON.stringify({ ...draft, lid: publishedLid }) : null;
  const statements: D1PreparedStatement[] = [];
  const publishCheck =
    draft?.kind === "teacher"
      ? "AND NOT EXISTS (SELECT 1 FROM teachers WHERE name=? COLLATE NOCASE)"
      : draft?.kind === "course"
        ? "AND NOT EXISTS (SELECT 1 FROM courses WHERE course_id=? COLLATE NOCASE) AND NOT EXISTS (SELECT 1 FROM course_section WHERE lid=?)"
        : "";
  statements.push(
    db
      .prepare(`INSERT INTO catalog_submission_events (operation_id,submission_id,actor_id,action,reason,payload,created_at)
    SELECT ?,id,?,?,?,?,unixepoch() FROM catalog_submissions WHERE id=? AND status='pending'
      ${onlyNewSubmission ? "AND changes()>0" : ""} AND ${guard} ${publishCheck}`)
      .bind(
        operation,
        actor.userId,
        approved ? "approved" : "rejected",
        reason,
        payload,
        id,
        ...guardValues,
        ...(draft?.kind === "teacher" ? [draft.name] : draft?.kind === "course" ? [draft.courseId, publishedLid] : []),
      ),
  );
  const audited = "EXISTS (SELECT 1 FROM catalog_submission_events WHERE operation_id=? AND submission_id=?)";
  if (draft?.kind === "teacher") {
    statements.push(db.prepare(`INSERT INTO teachers(name) SELECT ? WHERE ${audited}`).bind(draft.name, operation, id));
  } else if (draft) {
    statements.push(
      db
        .prepare(`INSERT INTO courses(course_id,name) SELECT ?,? WHERE ${audited}`)
        .bind(draft.courseId, draft.name, operation, id),
    );
    statements.push(
      db
        .prepare(`INSERT INTO course_section(lid,course_id,college,elective_type,credits)
      SELECT ?,?,?,?,? WHERE ${audited}`)
        .bind(publishedLid, draft.courseId, draft.college, draft.electiveType, draft.credits, operation, id),
    );
    for (const [type, value] of [
      ["college", draft.college],
      ["lessonType", draft.electiveType],
    ]) {
      statements.push(
        db
          .prepare(`INSERT INTO category_options(category_type,position,value)
        SELECT ?,COALESCE(MAX(position),0)+1,? FROM category_options WHERE category_type=?
        HAVING ${audited} AND NOT EXISTS (SELECT 1 FROM category_options WHERE category_type=? AND value=?)`)
          .bind(type, value, type, operation, id, type, value),
      );
    }
  }
  statements.push(
    db
      .prepare(`UPDATE catalog_submissions SET status=?,reviewed_by=?,reviewed_at=unixepoch(),reason=?,
    approved_payload=?,operation_id=?,published_course_id=?,published_lid=?,
    published_teacher_id=${draft?.kind === "teacher" ? "(SELECT id FROM teachers WHERE name=?)" : "NULL"}
    WHERE id=? AND status='pending' AND ${audited}`)
      .bind(
        approved ? "approved" : "rejected",
        actor.userId,
        reason,
        payload,
        operation,
        draft?.courseId ?? null,
        publishedLid,
        ...(draft?.kind === "teacher" ? [draft.name] : []),
        id,
        operation,
        id,
      ),
  );
  return statements;
}

export async function publishCatalog(
  context: SubmitterContext,
  admin: AdminContext,
  id: string,
  draft: CatalogDraft,
  url: URL,
) {
  if (context.actor.userId !== admin.actor.userId || context.actor.sessionHash !== admin.actor.sessionHash)
    error(403, "管理员账号已变化，请刷新页面后重试。");
  if (await existingSubmission(context, id, true)) return false;
  const statements = [
    catalogInsert(context, id, draft, admin),
    ...catalogDecisionStatements(admin, id, true, DIRECT_REASON, draft, true),
    // A direct publication must not leave a pending row. Reuse the existing
    // immutable-decision trigger as a transaction assertion: this UPDATE aborts
    // the entire batch only if approval failed after the new proposal was inserted.
    context.db
      .prepare("UPDATE catalog_submissions SET status='pending' WHERE id=? AND author_id=? AND status='pending'")
      .bind(id, context.actor.userId),
  ];
  let results: D1Result[];
  try {
    results = await context.db.batch(statements);
  } catch (reason) {
    if (String(reason).includes("LXK_SUBMISSION_ALREADY_REVIEWED"))
      return submissionFailure(context, draft, admin, true);
    throw reason;
  }
  if (results.at(-2)?.meta.changes) {
    await invalidateCatalog(url);
    return true;
  }
  // Concurrent retries reuse the saved record and never create a second audit.
  if (await existingSubmission(context, id, true)) return false;
  return submissionFailure(context, draft, admin);
}

export async function decideCatalog(
  context: AdminContext,
  id: string,
  approved: boolean,
  reason: string,
  form: FormData,
  url: URL,
) {
  const original = await context.db
    .prepare("SELECT kind,status FROM catalog_submissions WHERE id=?")
    .bind(id)
    .first<{ kind: CatalogKind; status: string }>();
  if (!original || original.status !== "pending") return false;
  const draft = approved ? parseCatalogDraft(form, original.kind) : null;
  // D1 batches are transactional. A collision, failed section insert or trigger
  // rolls back the audit, catalog inserts, counters and decision together.
  const results = await context.db.batch(catalogDecisionStatements(context, id, approved, reason, draft));
  const changed = !!results.at(-1)?.meta.changes;
  if (changed && approved) await invalidateCatalog(url);
  return changed;
}
