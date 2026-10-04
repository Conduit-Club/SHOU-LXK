<script lang="ts">
import ReviewCard from "#lib/components/review-card.svelte";
import DirectorySearch from "#lib/components/directory-search.svelte";
import PagePagination from "#lib/components/page-pagination.svelte";
import { MessageSquareText } from "@lucide/svelte";
import type { ActionData, PageData } from "./$types";
import { page } from "$app/state";
import ManagementFilters from "#lib/components/management-filters.svelte";
let { data, form }: { data: PageData; form: ActionData } = $props();
const pageUrl = (number: number) => {
  const params = new URLSearchParams(page.url.search);
  for (const key of [...params.keys()].filter((key) => key.startsWith("/"))) params.delete(key);
  params.set("page", String(number));
  return `/reviews?${params}`;
};
</script>

<svelte:head
  ><title>点评 · SHOU LXK</title><meta
    name="description"
    content="阅读课程与老师点评，搜索同学分享的课堂体验。"
  /></svelte:head
>
<main id="main-content" class="directory-page">
  <header class="section-heading">
    <div>
      <p class="eyebrow">CAMPUS VOICES / 点评</p>
      <h1 class="text-3xl font-semibold sm:text-4xl">每一种课堂，都有回响。</h1>
      <p class="mt-3 text-sm text-muted-foreground">课程与老师的真实体验，按发布时间排列。</p>
    </div>
    <span class="count-note">{data.total.toLocaleString()} 条点评</span>
  </header>
  {#if form?.message}<p role="status" class="mb-5 rounded-lg border border-border bg-muted px-4 py-3 text-sm">
      {form.message}
    </p>{/if}
  {#if data.managementMode && data.filters}
    <p class="text-sm text-primary">管理模式已开启 · 可原位删除、恢复与管理作者。</p>
    <ManagementFilters action="/reviews" filters={data.filters} />
  {:else}<DirectorySearch action="/reviews" q={data.q} label="搜索点评" placeholder="搜索点评标题或正文" />{/if}
  <div class="review-stack mt-6">
    {#each data.reviews as review (review.review_type + review.id)}<ReviewCard
        {review}
        csrfToken={data.managementMode ? data.auth?.csrfToken : undefined}
      />{:else}<div class="directory-empty">
        <MessageSquareText class="size-8" aria-hidden="true" />
        <h2>还没有找到这样的点评</h2>
        <p>换个关键词，或看看同学最近的分享。</p>
        <a href="/reviews">查看所有点评 →</a>
      </div>{/each}
  </div>
  {#if data.pages > 1}<PagePagination
      count={data.total}
      perPage={data.pageSize}
      page={data.page}
      label="点评页面"
      {pageUrl}
    />{/if}
</main>
