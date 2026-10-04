<script lang="ts">
import { sectionLabel } from "#lib/catalog.js";
import TeacherLinks from "#lib/components/teacher-links.svelte";
import BackToList from "#lib/components/back-to-list.svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import * as Select from "#lib/components/ui/select/index.js";
import { MessageSquareText } from "@lucide/svelte";
import { Button } from "#lib/components/ui/button/index.js";
import { Separator } from "#lib/components/ui/separator/index.js";
import PagePagination from "#lib/components/page-pagination.svelte";
import ReviewSendingCard from "#lib/components/review-sending-card.svelte";
import ReviewLoginCard from "#lib/components/review-login-card.svelte";
import type { ActionData, PageData } from "./$types";
import ReviewAuthor from "#lib/components/review-author.svelte";
import ReviewManagement from "#lib/components/review-management.svelte";
import ManagementStatus from "#lib/components/management-status.svelte";

let { data, form }: { data: PageData; form: ActionData } = $props();

const visibleSections = $derived(data.section ? [data.section] : data.sections);
const teachers = $derived([
  ...new Map(visibleSections.flatMap((section) => section.teachers).map((teacher) => [teacher.id, teacher])).values(),
]);
const details = $derived([
  {
    label: "开课学院",
    value: [...new Set(visibleSections.map((section) => section.college).filter(Boolean))].join(" / "),
  },
  {
    label: "选课类型",
    value: [...new Set(visibleSections.map((section) => section.elective_type).filter(Boolean))].join(" / "),
  },
  { label: "学分", value: [...new Set(visibleSections.map((section) => section.credits))].join(" / ") },
  {
    label: "课程属性",
    value: [...new Set(visibleSections.map((section) => section.attribute?.trim()).filter(Boolean))].join(" / "),
  },
]);

const pageUrl = (page: number, sort = data.sort) => {
  const params = new URLSearchParams({ page: String(page) });
  if (data.managementMode && data.deleted) params.set("status", "deleted");
  if (sort === "oldest") params.set("sort", sort);
  if (data.section) params.set("lid", data.section.lid);
  return `?${params}`;
};
const writeUrl = $derived(`${pageUrl(data.page)}&write=1#review-composer`);
</script>

<svelte:head>
  <title>{data.course.name} · SHOU LXK</title>
  <meta name="description" content={`查看${data.course.name}的课程信息、授课教师与同学点评。`} />
</svelte:head>

<main id="main-content" class="mx-auto w-full max-w-6xl px-4 pb-20 pt-8 sm:px-6 sm:pt-10">
  <BackToList />

  <div class="mt-8 grid items-start gap-7 lg:grid-cols-[minmax(0,1fr)_290px]">
    <div class="min-w-0">
      <header class="mb-6 flex flex-wrap items-end justify-between gap-5">
        <div>
          <p class="mb-3 text-xs font-medium tracking-widest text-muted-foreground">
            课程详情 / {data.course.course_id}
          </p>
          <h1 class="text-3xl font-semibold tracking-tight text-primary sm:text-4xl">{data.course.name}</h1>
          <p class="mt-3 text-sm text-muted-foreground">
            {data.section ? sectionLabel(data.section.lid) : "全部课段"} · {data.total} 条点评
          </p>
        </div>
        {#if data.sections.length}<Button href={writeUrl}>＋ 写点评</Button>{/if}
      </header>

      <section aria-labelledby="course-information" class="mb-7 rounded-xl border border-border bg-card">
        <h2 id="course-information" class="border-b border-border px-5 py-4 font-semibold">课程信息</h2>
        <dl class="grid gap-x-6 gap-y-5 p-5 sm:grid-cols-2">
          {#each details.filter((detail) => detail.value) as detail (detail.label)}
            <div>
              <dt class="mb-2 text-xs text-muted-foreground">{detail.label}</dt>
              <dd class="text-sm leading-6">{detail.value}</dd>
            </div>
          {/each}
          <div>
            <dt class="mb-2 text-xs text-muted-foreground">授课教师</dt>
            <dd class="text-sm leading-6"><TeacherLinks {teachers} /></dd>
          </div>
          <div>
            <dt class="mb-2 text-xs text-muted-foreground">收录班级</dt>
            <dd class="text-sm leading-6">{data.sections.length} 个</dd>
          </div>
        </dl>
      </section>

      {#if data.submitted}
        <p class="mb-6 rounded-lg border border-border bg-muted px-4 py-3 text-sm" role="status">
          评价已提交，感谢分享。
        </p>
      {/if}
      {#if form?.moderation && form.message}<p
          role="status"
          class="mb-6 rounded-lg border border-border bg-muted px-4 py-3 text-sm"
        >
          {form.message}
        </p>{/if}

      <div class="mb-5 flex flex-wrap items-center justify-between gap-4">
        <h2 class="text-lg font-semibold tracking-tight">同学点评</h2>
        <div class="flex items-center gap-3">
          <p class="text-sm tabular-nums text-muted-foreground">共{data.total.toLocaleString()}条</p>
          <Select.Root
            type="single"
            value={data.sort}
            onValueChange={(value) => {
              if (value === "latest" || value === "oldest") {
                void goto(pageUrl(1, value), { reset: false, replace: true });
              }
            }}
          >
            <Select.Trigger aria-label="评价排序">
              <Select.Value>{data.sort === "oldest" ? "最早优先" : "最新优先"}</Select.Value>
            </Select.Trigger>
            <Select.Content>
              <Select.Group>
                <Select.Item value="latest" label="最新优先">最新优先</Select.Item>
                <Select.Item value="oldest" label="最早优先">最早优先</Select.Item>
              </Select.Group>
            </Select.Content>
          </Select.Root>
        </div>
      </div>

      {#if data.managementMode}<ManagementStatus deleted={data.deleted} />{/if}
      {#if data.reviews.length}
        <ol class="flex flex-col gap-4">
          {#each data.reviews as review (review.id)}
            <li class="rounded-xl border border-border bg-card p-5 text-card-foreground shadow-xs sm:p-6">
              <div class="mb-4"><ReviewAuthor identity={review} /></div>
              {#if review.title}
                <h3 class="text-base font-semibold tracking-tight">{review.title}</h3>
              {/if}
              <p class="text-sm text-muted-foreground" class:mt-2={review.title}>
                <time>{review.posted_at_local}</time>
              </p>
              <Separator class="my-4" />
              <p class="whitespace-pre-wrap wrap-break-words text-sm leading-7 sm:text-base">{review.content}</p>
              {#if review.moderation && data.auth?.isAdmin}<ReviewManagement
                  reviewId={review.id}
                  kind="course"
                  management={review.moderation}
                  csrfToken={data.auth.csrfToken}
                />{/if}
            </li>
          {/each}
        </ol>
      {:else}
        <div
          class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-14 text-center"
        >
          <span class="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground"
            ><MessageSquareText class="size-5" aria-hidden="true" /></span
          >
          <h3 class="text-lg font-semibold">暂无评价</h3>
          <p class="text-sm text-muted-foreground">这门课还没有可展示的评价。</p>
          <Button href="/" variant="outline" class="mt-1">浏览其他课程</Button>
        </div>
      {/if}

      {#if data.pages > 1}
        <PagePagination
          count={data.total}
          perPage={data.pageSize}
          page={data.page}
          label="评价页面"
          {pageUrl}
          replaceState
        />
      {/if}
      {#if data.sections.length}
        <section id="review-composer" aria-label="发表点评" class="mt-8 scroll-mt-24">
          {#if !data.auth?.username}
            <ReviewLoginCard
              returnTo={`${page.url.pathname}${writeUrl}`}
              enabled={data.authEnabled}
              needsProfile={!!data.auth}
            />
          {:else if data.writing || (form && !form.moderation)}
            <ReviewSendingCard
              heading="分享你的课堂体验"
              turnstileSiteKey={data.turnstileSiteKey}
              form={form?.moderation ? null : form}
              sections={data.sections}
              selectedLid={data.section?.lid}
              csrfToken={data.auth.csrfToken}
              username={data.auth.username}
            />
          {:else}
            <div class="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-5">
              <div>
                <h2 class="font-semibold">这门课，你怎么看？</h2>
                <p class="mt-1 text-sm text-muted-foreground">分享亲身体验，给下一位同学一份参考。</p>
              </div>
              <Button href={writeUrl}>写点评</Button>
            </div>
          {/if}
        </section>
      {/if}
    </div>

    <aside class="flex min-w-0 flex-col gap-6" aria-label="课程相关信息">
      <section class="rounded-xl border border-border bg-card">
        <h2 class="border-b border-border px-5 py-4 font-semibold">授课教师</h2>
        <div class="divide-y divide-border px-5">
          {#each teachers as teacher (teacher.id)}
            <a href={`/teachers/${teacher.id}`} class="flex items-center gap-3 py-4 hover:text-primary">
              <span
                class="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
                aria-hidden="true">{teacher.name.slice(0, 1)}</span
              >
              <span class="font-medium">{teacher.name}</span>
            </a>
          {:else}<p class="py-5 text-sm text-muted-foreground">暂无教师信息</p>{/each}
        </div>
      </section>
      {#if data.sections.length > 1}
        <section class="rounded-xl border border-border bg-card">
          <h2 class="border-b border-border px-5 py-4 font-semibold">这门课的其他班级</h2>
          <div class="max-h-80 overflow-y-auto px-5">
            <a href={`/courses/${data.course.course_id}`} class="block border-b border-border py-3 text-sm text-primary"
              >查看全部班级点评</a
            >
            {#each data.sections.filter((section) => section.lid !== data.section?.lid) as section (section.lid)}
              <a
                href={`?lid=${encodeURIComponent(section.lid)}`}
                class="block border-b border-border py-4 last:border-0 hover:text-primary"
              >
                <p class="text-sm font-medium">
                  {section.teachers.map((teacher) => teacher.name).join("、") || "暂无教师信息"}
                </p>
                <p class="mt-2 text-xs text-muted-foreground">
                  {sectionLabel(section.lid)} · {section.review_count} 条点评
                </p>
              </a>
            {/each}
          </div>
        </section>
      {/if}
      <section class="rounded-xl border border-border bg-card">
        <div class="border-b border-border px-5 py-4">
          <h2 class="font-semibold">相似课程</h2>
          {#if data.recommendationBasis}<p class="mt-2 text-xs leading-5 text-muted-foreground">
              {data.recommendationBasis.college} · {data.recommendationBasis.credits} 学分
            </p>{/if}
        </div>
        <div class="divide-y divide-border px-5">
          {#each data.similarCourses as course (course.course_id)}
            <a
              href={`/courses/${course.course_id}?lid=${encodeURIComponent(course.lid)}`}
              class="block py-4 hover:text-primary"
            >
              <p class="text-sm font-medium leading-6">{course.name}</p>
              <p class="mt-2 text-xs leading-5 text-muted-foreground">
                {course.elective_type} · {course.review_count} 条班级点评
              </p>
            </a>
          {:else}<p class="py-5 text-sm text-muted-foreground">暂无可展示的相似课程。</p>{/each}
        </div>
      </section>
    </aside>
  </div>
</main>
