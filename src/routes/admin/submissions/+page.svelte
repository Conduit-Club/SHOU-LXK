<script lang="ts">
import { enhance } from "$app/forms";
import { page } from "$app/state";
import CatalogFields from "#lib/components/catalog-fields.svelte";
import PagePagination from "#lib/components/page-pagination.svelte";
import { catalogStatus, catalogTime, catalogLink } from "#lib/catalog.js";
import type { ActionData, PageData } from "./$types";
let { data, form }: { data: PageData; form: ActionData } = $props();
let sending = $state<string | null>(null);
const pageUrl = (number: number) => {
  const params = new URLSearchParams(page.url.search);
  for (const key of [...params.keys()].filter((key) => key.startsWith("/"))) params.delete(key);
  params.set("page", String(number));
  return `/admin/submissions?${params}`;
};
</script>

<svelte:head><title>目录补充审核 · SHOU LXK</title><meta name="robots" content="noindex,nofollow" /></svelte:head>
<main id="main-content" class="mx-auto min-w-0 max-w-4xl px-4 py-8 sm:px-6">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <h1 class="text-2xl font-semibold">目录补充审核</h1>
    <a href="/admin" class="text-sm text-primary">点评管理 →</a>
  </div>
  <p class="mt-3 text-sm leading-7 text-muted-foreground">
    核实课程号、老师姓名与课程信息后收录。通过或拒绝均需填写理由；原始提交保留，理由可由提交者查看。通过后才能浏览、搜索并发表点评。
  </p>
  <p class="mt-2 text-xs text-muted-foreground">权限每次验证最多有效一小时，到期后请通过顶部入口重新验证。</p>
  {#if form?.message}<p class="mt-5 rounded-lg border border-border bg-muted p-4 text-sm" role="status">
      {form.message}
    </p>{/if}
  <form method="GET" class="my-6 grid min-w-0 gap-3 rounded-lg border border-border p-4 sm:grid-cols-3">
    <label class="catalog-field" for="queue-search"
      ><span>姓名、课程名或课程号</span><input
        id="queue-search"
        type="search"
        name="q"
        maxlength="100"
        value={data.filters.q}
      /></label
    >
    <label class="catalog-field" for="queue-kind"
      ><span>条目类型</span><select id="queue-kind" name="kind" value={data.filters.kind}
        ><option value="all">全部</option><option value="course">课程</option><option value="teacher">老师</option
        ></select
      ></label
    >
    <label class="catalog-field" for="queue-status"
      ><span>审核状态</span><select id="queue-status" name="status" value={data.filters.status}
        ><option value="pending">待审核</option><option value="approved">已收录</option><option value="rejected"
          >未通过</option
        ></select
      ></label
    >
    <button class="justify-self-start rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground" type="submit"
      >筛选</button
    >
  </form>
  <p class="mb-4 text-sm text-muted-foreground">共 {data.total} 条 · 第 {data.page} / {data.pages} 页</p>
  <ol class="space-y-5">
    {#each data.submissions as item (item.id)}
      <li class="min-w-0 rounded-xl border border-border bg-card p-4 leading-7 wrap-anywhere sm:p-6">
        <p class="flex flex-wrap justify-between gap-2">
          <span class="font-semibold">{item.kind === "course" ? "课程" : "老师"} · {item.name}</span><span
            class="text-sm text-primary">{catalogStatus[item.status]}</span
          >
        </p>
        <p class="mt-1 text-xs text-muted-foreground">
          提交者 {item.author_name ?? "未设置用户名"} / #{item.author_id} · {catalogTime(item.created_at)}
        </p>
        {#if item.kind === "course"}<p class="mt-2 text-sm text-muted-foreground">
            原提交：{item.course_id} · {item.college} · {item.elective_type} · {item.credits} 学分{item.lid
              ? ` · 班级 ${item.lid}`
              : " · 未提供班级编号"}
          </p>{/if}
        {#if item.note}<p class="mt-3 whitespace-pre-wrap text-sm">补充说明：{item.note}</p>{/if}
        {#if item.status === "pending"}
          <details class="mt-4 border-t border-border pt-3">
            <summary class="cursor-pointer text-sm font-medium text-primary">核对信息并审核</summary>
            <form
              method="POST"
              action="?/decide"
              class="mt-4 min-w-0"
              use:enhance={() => {
                sending = item.id;
                return async ({ update }) => {
                  sending = null;
                  await update({ reset: false });
                };
              }}
            >
              <input type="hidden" name="csrfToken" value={data.auth?.csrfToken} />
              <input type="hidden" name="submissionId" value={item.id} />
              <CatalogFields
                kind={item.kind}
                prefix={item.id}
                compact
                values={{
                  name: item.name,
                  courseId: item.course_id,
                  college: item.college,
                  electiveType: item.elective_type,
                  credits: item.credits,
                  lid: item.lid,
                }}
              />
              <label class="catalog-field mt-4" for={`reason-${item.id}`}
                ><span>审核理由（通过与拒绝均必填）</span><textarea
                  id={`reason-${item.id}`}
                  name="reason"
                  required
                  maxlength="500"
                  rows="3"
                  placeholder="填写核实依据或未通过的原因，提交者可查看。"></textarea></label
              >
              {#if form?.submissionId === item.id && form.message}<p class="mt-3 text-sm text-primary" role="status">
                  {form.message}
                </p>{/if}
              <div class="mt-4 flex flex-wrap gap-3">
                <button
                  type="submit"
                  name="decision"
                  value="approve"
                  class="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
                  disabled={sending === item.id}>通过并收录</button
                >
                <button
                  type="submit"
                  name="decision"
                  value="reject"
                  formnovalidate
                  class="rounded-md border border-border px-4 py-2 text-sm text-destructive disabled:opacity-50"
                  disabled={sending === item.id}>拒绝</button
                >
              </div>
            </form>
          </details>
        {:else}
          <p class="mt-3 border-t border-border pt-3 text-sm">
            管理员 #{item.reviewed_by} · {catalogTime(item.reviewed_at!)} · {item.reason}
          </p>
          {#if catalogLink(item)}<a href={catalogLink(item)} class="mt-2 inline-flex text-sm text-primary"
              >查看已收录条目 →</a
            >{/if}
        {/if}
      </li>
    {:else}<li class="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        此筛选没有目录补充。
      </li>{/each}
  </ol>
  {#if data.pages > 1}<PagePagination
      count={data.total}
      perPage={data.pageSize}
      page={data.page}
      label="目录审核分页"
      {pageUrl}
    />{/if}
</main>
