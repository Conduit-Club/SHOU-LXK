import { getBindings } from "#lib/server/platform.js";
import { withTeachers } from "#lib/server/teachers.js";
import { error, fail, redirect } from "@sveltejs/kit";
import { verifyTurnstile } from "#lib/server/turnstile.js";
import { invalidateHomeReviews, loadSimilarCandidates } from "#lib/server/home-cache.js";
import { reviewSession, reviewWriteGuard, writeReview } from "#lib/server/auth.js";
import { publicReviewProjection, reviewIdentity } from "#lib/server/review-identity.js";
import type { PublicReviewIdentity } from "#lib/server/review-identity.js";
import { loadManagedReviews, managementContext } from "#lib/server/moderation.js";
import type { ReviewManagement } from "#lib/server/moderation.js";
import { moderationActions } from "#lib/server/moderation-actions.js";
import type { Actions, PageServerLoad } from "./$types";

const PAGE_SIZE = 20;

type Course = { course_id: string; name: string };
type Section = {
  lid: string;
  college: string;
  elective_type: string;
  credits: number;
  attribute: string | null;
  review_count: number;
};
type SimilarCourse = Section & { course_id: string; name: string };
type Review = PublicReviewIdentity & {
  lid: string | null;
  id: number;
  title: string;
  content: string;
  posted_at_local: string;
  moderation?: ReviewManagement;
};

export const load: PageServerLoad = async (event) => {
  const { params, platform, url } = event;
  const db = getBindings(platform).DB;
  if (!db) error(503, "加载失败，请稍后重试。");

  const course = await db
    .prepare("SELECT course_id, name FROM courses WHERE course_id = ?")
    .bind(params.courseId)
    .first<Course>();
  if (!course) error(404, "Course not found.");

  const sections = await db
    .prepare(
      "SELECT lid, college, elective_type, credits, attribute, review_count FROM course_section WHERE course_id = ? ORDER BY lid",
    )
    .bind(course.course_id)
    .all<Section>();

  const sectionChoices = await withTeachers(db, sections.results);
  const lid = url.searchParams.get("lid");
  const section = lid ? sectionChoices.find((choice) => choice.lid === lid) : null;
  if (lid && !section) error(404, "Course section not found.");
  const sectionFilter = section ? "AND ci.lid = ?" : "";
  const reviewValues = section ? [course.course_id, section.lid] : [course.course_id];
  const management = await managementContext(event);
  const managed = management
    ? await loadManagedReviews(management, url, { kind: "course", courseId: course.course_id, lid: section?.lid })
    : null;

  // These counters are maintained transactionally by the review triggers.
  const total =
    managed?.total ?? section?.review_count ?? sectionChoices.reduce((sum, item) => sum + item.review_count, 0);
  const recommendationBasis = section ?? sectionChoices[0] ?? null;
  let similarCourses: SimilarCourse[] = [];
  if (recommendationBasis?.college) {
    // Bound the indexed candidate pool BEFORE joining/ranking. This is a small
    // selection of related courses, not a full-catalog popularity ranking.
    const results = await loadSimilarCandidates<SimilarCourse>(
      db,
      url,
      recommendationBasis.college,
      recommendationBasis.credits,
    );
    const seen = new Set([course.course_id]);
    similarCourses = results
      .sort((a, b) => b.review_count - a.review_count || a.lid.localeCompare(b.lid))
      .filter((item) => {
        if (seen.has(item.course_id)) return false;
        seen.add(item.course_id);
        return true;
      })
      .slice(0, 5);
  }
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const requestedPage = Number(url.searchParams.get("page") ?? "1");
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, pages) : 1;

  const sort = url.searchParams.get("sort") === "oldest" ? "oldest" : "latest";
  const direction = sort === "oldest" ? "ASC" : "DESC";

  const { results: reviews } = managed
    ? { results: managed.reviews }
    : await db
        .prepare(`
    SELECT r.id, r.lid, r.title, r.content, r.posted_at_local, ${publicReviewProjection("r.")}
    FROM course_section AS ci
    JOIN course_reviews AS r ON r.lid = ci.lid
    WHERE ci.course_id = ? ${sectionFilter}
    ORDER BY r.posted_at_local ${direction}, r.id ${direction}
    LIMIT ? OFFSET ?
  `)
        .bind(...reviewValues, PAGE_SIZE, (page - 1) * PAGE_SIZE)
        .all<Review>();

  return {
    course,
    similarCourses,
    recommendationBasis,
    writing: url.searchParams.get("write") === "1",
    section,
    sections: sectionChoices,
    reviews,
    managementMode: !!management,
    deleted: managed?.deleted ?? false,
    sort,
    total,
    page,
    pages,
    pageSize: PAGE_SIZE,
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
    const lid = form.get("lid");
    const submittedTitle = form.get("title");
    const submittedContent = form.get("content");
    const title = typeof submittedTitle === "string" ? submittedTitle.trim() : "";
    const content = typeof submittedContent === "string" ? submittedContent.trim() : "";
    const values = { title, content, lid: typeof lid === "string" ? lid : "", visibility: identity.visibility };

    const verification = await verifyTurnstile(form, getBindings(platform).TURNSTILE_SECRET_KEY, url.hostname, fetch);
    if (!verification.success) {
      return fail(verification.status, { message: verification.message, ...values });
    }

    if (!title || title.length > 120 || !content || content.length > 5000) {
      return fail(400, { message: "请填写标题（最多120字）和正文（最多5000字）。", ...values });
    }
    if (typeof lid !== "string" || !lid) {
      return fail(400, { message: "请选择课程班级。", ...values });
    }

    const section = await db
      .prepare("SELECT lid FROM course_section WHERE lid = ? AND course_id = ?")
      .bind(lid, params.courseId)
      .first<{ lid: string }>();
    if (!section) return fail(400, { message: "请选择有效的课程班级。", ...values });

    const postedAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
    const guard = reviewWriteGuard(session, getBindings(platform));
    const result = await writeReview(
      db
        .prepare(`
        INSERT INTO course_reviews (lid, title, content, posted_at_local, author_id, is_anonymous, public_username, public_avatar_url)
        SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}
      `)
        .bind(
          lid,
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
        reviewType: "course",
        reviewId: result.meta.last_row_id,
        courseId: params.courseId,
        lid,
      }),
    );

    const destination = new URL(url.pathname, url);
    destination.searchParams.set("lid", lid);
    destination.searchParams.set("submitted", "1");
    redirect(303, `${destination.pathname}${destination.search}`);
  },
};
