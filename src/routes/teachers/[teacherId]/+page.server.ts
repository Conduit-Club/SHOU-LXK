import { getBindings } from "#lib/server/platform.js";
import { error, fail, redirect } from "@sveltejs/kit";
import { verifyTurnstile } from "#lib/server/turnstile.js";
import { invalidateHomeReviews } from "#lib/server/home-cache.js";
import { reviewSession, reviewWriteGuard, writeReview } from "#lib/server/auth.js";
import { publicReviewProjection, reviewIdentity } from "#lib/server/review-identity.js";
import type { PublicReviewIdentity } from "#lib/server/review-identity.js";
import { loadManagedReviews, managementContext } from "#lib/server/moderation.js";
import type { ReviewManagement } from "#lib/server/moderation.js";
import { moderationActions } from "#lib/server/moderation-actions.js";
import type { Teacher } from "#lib/server/teachers.js";
import type { Actions, PageServerLoad } from "./$types";

const PAGE_SIZE = 20;
type Review = PublicReviewIdentity & {
  id: number;
  title: string;
  content: string;
  posted_at_local: string;
  moderation?: ReviewManagement;
};
type Course = { course_id: string; name: string; lid: string; college: string; credits: number };

async function getTeacher(db: D1Database, id: string) {
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) error(404, "Teacher not found.");
  const teacher = await db.prepare("SELECT id, name FROM teachers WHERE id = ?").bind(Number(id)).first<Teacher>();
  if (!teacher) error(404, "Teacher not found.");
  return teacher;
}

export const load: PageServerLoad = async (event) => {
  const { params, platform, url } = event;
  const db = getBindings(platform).DB;
  if (!db) error(503, "加载失败，请稍后重试。");
  const teacher = await getTeacher(db, params.teacherId);
  const management = await managementContext(event);
  const managed = management
    ? await loadManagedReviews(management, url, { kind: "teacher", teacherId: teacher.id })
    : null;
  const courses = await db
    .prepare(`SELECT c.course_id, c.name, cs.lid, cs.college, cs.credits
    FROM course_section_teachers AS st
    JOIN course_section AS cs ON cs.lid = st.lid
    JOIN courses AS c ON c.course_id = cs.course_id
    WHERE st.teacher_id = ? ORDER BY c.name, c.course_id, cs.lid`)
    .bind(teacher.id)
    .all<Course>();
  const count = managed
    ? { total: managed.total }
    : await db
        .prepare("SELECT COUNT(*) AS total FROM teacher_reviews WHERE teacher_id = ?")
        .bind(teacher.id)
        .first<{ total: number }>();
  const total = count?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const requestedPage = Number(url.searchParams.get("page") ?? "1");
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, pages) : 1;
  const sort = url.searchParams.get("sort") === "oldest" ? "oldest" : "latest";
  const direction = sort === "oldest" ? "ASC" : "DESC";
  const reviews = managed
    ? { results: managed.reviews }
    : await db
        .prepare(`SELECT id, title, content, posted_at_local, ${publicReviewProjection()} FROM teacher_reviews
    WHERE teacher_id = ? ORDER BY posted_at_local ${direction}, id ${direction} LIMIT ? OFFSET ?`)
        .bind(teacher.id, PAGE_SIZE, (page - 1) * PAGE_SIZE)
        .all<Review>();
  return {
    teacher,
    courses: courses.results,
    reviews: reviews.results,
    managementMode: !!management,
    deleted: managed?.deleted ?? false,
    total,
    pages,
    page,
    pageSize: PAGE_SIZE,
    sort,
    turnstileSiteKey: getBindings(platform).TURNSTILE_SITE_KEY ?? "",
    submitted: url.searchParams.get("submitted") === "1",
  };
};

export const actions: Actions = {
  ...moderationActions,
  submitReview: async (event) => {
    const { params, platform, request, url, fetch } = event;
    const db = getBindings(platform).DB;
    if (!db) error(503, "加载失败，请稍后重试。");
    const form = await request.formData();
    const session = await reviewSession(event, form);
    const identity = reviewIdentity(form, session);
    const rawTitle = form.get("title");
    const rawContent = form.get("content");
    const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
    const content = typeof rawContent === "string" ? rawContent.trim() : "";
    const values = { title, content, visibility: identity.visibility };
    const verification = await verifyTurnstile(form, getBindings(platform).TURNSTILE_SECRET_KEY, url.hostname, fetch);
    if (!verification.success) {
      return fail(verification.status, { message: verification.message, ...values });
    }
    const teacher = await getTeacher(db, params.teacherId);
    if (!title || title.length > 120 || !content || content.length > 5000) {
      return fail(400, { message: "请填写标题（最多120字）和正文（最多5000字）。", ...values });
    }
    const postedAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
    const guard = reviewWriteGuard(session, getBindings(platform));
    const result = await writeReview(
      db
        .prepare(
          `INSERT INTO teacher_reviews (teacher_id, title, content, posted_at_local, author_id, is_anonymous, public_username, public_avatar_url)
          SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`,
        )
        .bind(
          teacher.id,
          title,
          content,
          postedAt,
          session.userId,
          identity.anonymous,
          identity.username,
          identity.avatar,
          ...guard.values,
        ),
      db,
      session.userId,
    );
    await invalidateHomeReviews(url);
    console.info(
      JSON.stringify({
        event: "review_added",
        reviewType: "teacher",
        reviewId: result.meta.last_row_id,
        teacherId: teacher.id,
      }),
    );
    redirect(303, `${url.pathname}?submitted=1`);
  },
};
