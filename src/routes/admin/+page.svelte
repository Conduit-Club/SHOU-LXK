<script lang="ts">
import { page } from "$app/state";
import ReviewCard from "#lib/components/review-card.svelte";
import ManagementFilters from "#lib/components/management-filters.svelte";
import type { ActionData, PageData } from "./$types";
let { data, form }: { data: PageData; form: ActionData } = $props();
const pageUrl = (number: number, key = "page") => {
  const params = new URLSearchParams(page.url.search);
  for (const entry of [...params.keys()].filter((key) => key.startsWith("/"))) params.delete(entry);
  params.set(key, String(number));
  return `/admin?${params}`;
};
const actionLabel = {
  archive_review: "删除点评",
  restore_review: "恢复点评",
  ban_user: "本站封禁",
  unban_user: "解除封禁",
};
const time = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
</script>

<svelte:head><title>点评管理 · SHOU LXK</title><meta name="robots" content="noindex,nofollow" /></svelte:head>
<main id="main-content" class="mx-auto max-w-6xl px-4 py-8 sm:px-6">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <h1 class="text-2xl font-semibold">点评管理</h1>
  </div>
  <p class="mt-3 text-sm leading-7 text-muted-foreground">
    按内容、课程、老师或作者查找点评，每次操作需填写理由。删除可恢复；本站封禁会立即撤销 LXK 会话，现有点评保留。
  </p>
  <nav class="mt-5 flex flex-wrap gap-3 text-sm" aria-label="管理员工作入口">
    <a href="/admin/submissions?kind=teacher" class="rounded-md border border-border px-4 py-2">老师审核</a>
    <a href="/admin/submissions?kind=course" class="rounded-md border border-border px-4 py-2">课程审核</a>
    <a href="/submissions?kind=teacher" class="rounded-md bg-primary px-4 py-2 text-primary-foreground">直接添加老师</a>
    <a href="/submissions?kind=course" class="rounded-md bg-primary px-4 py-2 text-primary-foreground">直接添加课程</a>
  </nav>
  <p class="mt-2 text-xs text-muted-foreground">
    管理权限每次验证最多有效一小时。权限到期后，可通过顶部“验证管理权限”重新登录。
  </p>
  {#if form?.message}<p class="mt-5 rounded-lg border border-border bg-muted p-4 text-sm" role="status">
      {form.message}
    </p>{/if}
  <ManagementFilters action="/admin" filters={data.filters} />
  <p class="mb-4 text-sm text-muted-foreground">共 {data.total} 条 · 第 {data.page} / {data.pages} 页</p>
  <div class="review-stack">
    {#each data.reviews as review (review.review_type + review.id)}
      <ReviewCard {review} csrfToken={data.auth?.csrfToken} />
    {:else}<p class="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        此筛选暂无点评。
      </p>{/each}
  </div>
  <nav class="my-6 flex items-center gap-4 text-sm" aria-label="点评管理分页">
    {#if data.page > 1}<a href={pageUrl(data.page - 1)} class="text-primary">上一页</a>{/if}
    {#if data.page < data.pages}<a href={pageUrl(data.page + 1)} class="text-primary">下一页</a>{/if}
  </nav>
  <section class="mt-10 border-t border-border pt-6" aria-labelledby="moderation-audit">
    <h2 id="moderation-audit" class="text-lg font-semibold">操作审计</h2>
    <p class="mt-2 text-sm text-muted-foreground">
      共 {data.auditPaging.total} 条 · 第 {data.auditPaging.page} / {data.auditPaging.pages} 页
    </p>
    <ol class="mt-4 space-y-3">
      {#each data.audit as item (item.operation_id)}<li class="rounded-md border border-border p-4 text-sm leading-6">
          <p>
            {time(item.created_at)} · 管理员 #{item.actor_id} · {actionLabel[item.action]} · {item.review_type ===
            "course"
              ? "课程点评"
              : item.review_type === "teacher"
                ? "教师点评"
                : "账号"} #{item.target_id}
          </p>
          <p class="mt-1 text-muted-foreground">{item.reason}</p>
        </li>{:else}<li class="text-sm text-muted-foreground">暂无管理操作。</li>{/each}
    </ol>
    <nav class="mt-5 flex items-center gap-4 text-sm" aria-label="审计分页">
      {#if data.auditPaging.page > 1}<a href={pageUrl(data.auditPaging.page - 1, "auditPage")} class="text-primary"
          >上一页</a
        >{/if}
      {#if data.auditPaging.page < data.auditPaging.pages}<a
          href={pageUrl(data.auditPaging.page + 1, "auditPage")}
          class="text-primary">下一页</a
        >{/if}
    </nav>
  </section>
</main>
