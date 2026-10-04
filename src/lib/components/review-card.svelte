<script lang="ts">
import { ArrowUpRight, ChevronDown } from "@lucide/svelte";
import ReviewAuthor from "./review-author.svelte";
import ReviewManagement from "./review-management.svelte";
import type { ReviewManagement as Management } from "#lib/server/moderation.js";
import type { LatestReview } from "#lib/server/home-queries.js";
let { review, csrfToken }: { review: LatestReview & { moderation?: Management }; csrfToken?: string } = $props();
let expanded = $state(false);
const bodyId = $derived(`review-${review.review_type}-${review.id}-body`);
const subject = $derived(review.review_type === "course" ? review.course_name : review.teacher_name);
const href = $derived(
  review.review_type === "course"
    ? `/courses/${encodeURIComponent(review.course_id ?? "")}?${new URLSearchParams({ lid: review.lid ?? "" })}`
    : `/teachers/${review.teacher_id}`,
);
</script>

<article class="review-card">
  <div class="review-meta">
    <div class="min-w-0 flex-1">
      <div class="mb-3"><ReviewAuthor identity={review} /></div>
      <p class="text-sm leading-6">
        <span class="review-kind">{review.review_type === "course" ? "课程点评" : "教师点评"}</span><span
          class="mx-2 text-muted-foreground">/</span
        ><a {href} class="font-medium">{subject}</a>
      </p>
      <p class="mt-1 text-xs text-muted-foreground">
        <time datetime={review.posted_at_local.replace(" ", "T") + "+08:00"}>{review.posted_at_local}</time>
      </p>
    </div>
  </div>
  <div class="review-content">
    {#if review.title}<h3 class="review-title text-base">{review.title}</h3>{/if}
    <p id={bodyId} class:line-clamp-4={!expanded}>{review.content}</p>
    <div class="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs font-medium">
      <button
        type="button"
        class="inline-flex items-center gap-1 text-primary"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onclick={() => (expanded = !expanded)}
      >
        {expanded ? "收起全文" : "展开全文"}<ChevronDown
          class={expanded ? "size-3.5 rotate-180" : "size-3.5"}
          aria-hidden="true"
        />
      </button>
      <a class="inline-flex items-center gap-1" {href}
        >查看{review.review_type === "course" ? "课程" : "老师"}<ArrowUpRight class="size-3.5" aria-hidden="true" /></a
      >
    </div>
  </div>
  {#if review.moderation && csrfToken}<ReviewManagement
      reviewId={review.id}
      kind={review.review_type}
      management={review.moderation}
      {csrfToken}
    />{/if}
</article>
