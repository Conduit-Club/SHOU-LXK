<script lang="ts">
import { page } from "$app/state";
import { Button } from "#lib/components/ui/button/index.js";
import type { ActionData, PageData } from "./$types";
let { data, form }: { data: PageData; form: ActionData } = $props();
const pageUrl = (number: number, key = "page") => {
  const params = new URLSearchParams(page.url.searchParams.toString());
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
  <h1 class="text-2xl font-semibold">点评管理</h1>
  <p class="mt-3 text-sm leading-7 text-muted-foreground">
    删除后可恢复，首页显示可能延迟约60秒更新。封禁只针对
    LXK，会立即撤销本站登录，现有点评保留；不影响统一账号中心或其他网站。每次操作必须填写理由。
  </p>
  {#if form?.message}<p class="mt-5 rounded-lg border border-border bg-muted p-4 text-sm" role="status">
      {form.message}
    </p>{/if}
  <nav class="my-6 flex flex-wrap items-center gap-3 text-sm" aria-label="管理筛选">
    <a
      href={`/admin?type=course&status=${data.deleted ? "deleted" : "active"}`}
      class:text-primary={data.kind === "course"}>课程点评</a
    >
    <a
      href={`/admin?type=teacher&status=${data.deleted ? "deleted" : "active"}`}
      class:text-primary={data.kind === "teacher"}>教师点评</a
    >
    <span class="text-muted-foreground" aria-hidden="true">·</span>
    <a href={`/admin?type=${data.kind}&status=active`} class:text-primary={!data.deleted}>公开中</a>
    <a href={`/admin?type=${data.kind}&status=deleted`} class:text-primary={data.deleted}>已删除</a>
  </nav>
  <p class="mb-4 text-sm text-muted-foreground">共 {data.total} 条 · 第 {data.page} / {data.pages} 页</p>
  <ol class="space-y-5">
    {#each data.reviews as review (review.id)}
      <li class="rounded-xl border border-border bg-card p-5">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 class="font-semibold">{review.title || "无标题"}</h2>
            <p class="mt-2 text-xs text-muted-foreground">
              #{review.id} · {review.target_name} · {review.posted_at_local}
            </p>
          </div>
        </div>
        <p class="mt-4 whitespace-pre-wrap wrap-break-words text-sm leading-7">{review.content}</p>
        {#if data.deleted && review.deleted_at}<p class="mt-4 text-sm text-muted-foreground">
            删除时间：{time(review.deleted_at)} · 理由：{review.reason}
          </p>{/if}
        <p class="mt-4 text-sm text-muted-foreground">
          {#if review.author_id === null}历史匿名点评，没有可追溯账号；可以删除或恢复，无法封禁作者。
          {:else}本站账号 #{review.author_id} · {review.author_name ?? "账号名称不可用"} · {review.banned_at
              ? "已封禁"
              : "正常"}{#if !review.canBan}
              · 管理员账号受保护{/if}{/if}
        </p>
        <div class="mt-5 grid gap-5 md:grid-cols-2">
          <form method="POST" action={data.deleted ? "?/restoreReview" : "?/archiveReview"} class="flex flex-col gap-2">
            <input type="hidden" name="csrfToken" value={data.auth?.csrfToken} />
            <input type="hidden" name="reviewType" value={data.kind} />
            <input type="hidden" name="reviewId" value={review.id} />
            <label for={`review-reason-${review.id}`} class="text-sm">{data.deleted ? "恢复" : "删除"}理由</label>
            <input
              id={`review-reason-${review.id}`}
              name="reason"
              maxlength="500"
              required
              class="rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <Button type="submit" variant={data.deleted ? "outline" : "destructive"} class="self-start"
              >{data.deleted ? "恢复点评" : "删除点评"}</Button
            >
          </form>
          {#if review.canBan && review.author_id !== null}
            <form method="POST" action={review.banned_at ? "?/unbanUser" : "?/banUser"} class="flex flex-col gap-2">
              <input type="hidden" name="csrfToken" value={data.auth?.csrfToken} />
              <input type="hidden" name="userId" value={review.author_id} />
              <label for={`ban-reason-${review.id}`} class="text-sm">{review.banned_at ? "解封" : "本站封禁"}理由</label
              >
              <input
                id={`ban-reason-${review.id}`}
                name="reason"
                maxlength="500"
                required
                class="rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
              <Button type="submit" variant="outline" class="self-start"
                >{review.banned_at ? "解除本站封禁" : "在本站封禁作者"}</Button
              >
            </form>
          {/if}
        </div>
      </li>
    {:else}<li class="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        此列表暂无点评。
      </li>{/each}
  </ol>
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
        </li>
      {:else}<li class="text-sm text-muted-foreground">暂无管理操作。</li>{/each}
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
