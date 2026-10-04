<script lang="ts">
import { enhance } from "$app/forms";
import { page } from "$app/state";
import { afterNavigate, invalidateAll } from "$app/navigation";
import CatalogFields from "#lib/components/catalog-fields.svelte";
import Turnstile from "#lib/components/turnstile.svelte";
import PagePagination from "#lib/components/page-pagination.svelte";
import { catalogStatus, catalogTime, catalogLink, DIRECT_CATALOG_LIMITS } from "#lib/catalog.js";
import type { ActionData, PageData } from "./$types";
let { data, form }: { data: PageData; form: ActionData } = $props();
let sending = $state(false);
let verified = $state(false);
let challengeAttempt = $state(0);
let submissionForm = $state<HTMLFormElement>();
let draftValues = $state<Record<string, string> | null>(null);
let refreshing = $state(false);
let renewalRecovered = $state(false);
let retainedDirectIntent = $state(false);
afterNavigate(({ from }) => {
  if (!from) return;
  // Type changes and successful redirects start a new form/UUID. A session
  // refresh uses invalidateAll and deliberately keeps the current draft.
  draftValues = null;
  retainedDirectIntent = false;
  renewalRecovered = false;
});
const fields = ["kind", "name", "courseId", "college", "electiveType", "credits", "lid", "note", "submissionId"];
const rememberDraft = (values: FormData) => {
  draftValues = Object.fromEntries(fields.map((key) => [key, String(values.get(key) ?? "")]));
};
const refreshSession = async () => {
  if (submissionForm) rememberDraft(new FormData(submissionForm));
  retainedDirectIntent = true;
  refreshing = true;
  try {
    await invalidateAll();
    renewalRecovered = data.canPublishDirectly;
    challengeAttempt++;
  } finally {
    refreshing = false;
  }
};
const kind = $derived(
  draftValues?.kind === "teacher"
    ? "teacher"
    : draftValues?.kind === "course"
      ? "course"
      : form?.values?.kind === "teacher"
        ? "teacher"
        : form?.values?.kind === "course"
          ? "course"
          : data.kind,
);
const pageUrl = (number: number) => `/submissions?${new URLSearchParams({ kind, page: String(number) })}`;
const loginUrl = $derived(`/auth/login?${new URLSearchParams({ returnTo: `${page.url.pathname}?kind=${kind}` })}`);
const directIntent = $derived(
  data.canPublishDirectly || data.adminNeedsRenewal || !!form?.renewAdmin || retainedDirectIntent,
);
const needsRenewal = $derived(
  data.adminNeedsRenewal || (directIntent && !data.canPublishDirectly) || (!!form?.renewAdmin && !renewalRecovered),
);
</script>

<svelte:head><title>补充课程与老师 · SHOU LXK</title><meta name="robots" content="noindex,nofollow" /></svelte:head>
<main id="main-content" class="mx-auto min-w-0 max-w-3xl px-4 py-8 sm:px-6">
  <h1 class="text-2xl font-semibold">{directIntent ? "直接添加老师 / 课程" : "补充课程与老师"}</h1>
  <p class="mt-3 text-sm leading-7 text-muted-foreground">
    {data.canPublishDirectly
      ? "你正在以管理员身份添加目录。确认信息后可直接收录并公开，同时保留原始资料与操作记录。"
      : "普通用户的目录补充经管理员核实后公开，你可以在此查看审核进度与理由。"}
    对已有课程和老师写点评，提交后即公开，无需事先审核。
  </p>
  <nav class="my-5 flex flex-wrap gap-3 text-sm" aria-label="目录补充类型">
    <a
      href="/submissions?kind=course"
      class="rounded-md border border-border px-4 py-2"
      aria-current={kind === "course" ? "page" : undefined}>补充课程 / 课程号</a
    >
    <a
      href="/submissions?kind=teacher"
      class="rounded-md border border-border px-4 py-2"
      aria-current={kind === "teacher" ? "page" : undefined}>补充老师</a
    >
  </nav>
  {#if data.canPublishDirectly}<nav class="mb-5 flex flex-wrap gap-3 text-sm" aria-label="目录管理入口">
      <a href="/admin/submissions?kind=teacher" class="rounded-md border border-border px-4 py-2">老师审核</a>
      <a href="/admin/submissions?kind=course" class="rounded-md border border-border px-4 py-2">课程审核</a>
      <a href="/admin" class="rounded-md border border-border px-4 py-2">点评管理</a>
    </nav>{/if}
  {#if form?.message && (!form.renewAdmin || !renewalRecovered)}<p
      class="mb-5 rounded-lg border border-border bg-muted p-4 text-sm"
      role="alert"
    >
      {form.message}
    </p>{/if}
  {#if data.resultSubmission}<div
      class="mb-5 rounded-lg border border-border bg-muted p-4 text-sm leading-7"
      role="status"
    >
      <p>
        {data.resultSubmission.name} · {catalogStatus[data.resultSubmission.status]}。{data.resultSubmission.status ===
        "approved"
          ? "条目已公开，可以浏览并发表点评。"
          : data.resultSubmission.status === "pending"
            ? "审核前不会出现在公开目录。"
            : "请查看下方处理理由。"}
      </p>
      {#if catalogLink(data.resultSubmission)}<a
          href={catalogLink(data.resultSubmission)}
          class="mt-2 inline-flex text-primary">查看已收录条目 →</a
        >{/if}
    </div>{/if}
  {#if needsRenewal}<div class="mb-5 rounded-xl border border-border bg-card p-5 text-sm leading-7" role="alert">
      <p>管理员权限已到期或发生变化。请重新验证后直接添加；本次不会转为普通待审补充。</p>
      <div class="mt-3 flex flex-wrap items-center gap-4">
        <a
          href={loginUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-sveltekit-reload
          class="inline-flex text-primary">在新标签验证管理员权限 →</a
        >
        <button
          type="button"
          onclick={refreshSession}
          disabled={refreshing}
          class="rounded-md border border-border px-3 py-1.5 text-primary disabled:opacity-50"
          >{refreshing ? "正在恢复…" : "已完成验证，恢复当前表单"}</button
        >
      </div>
    </div>{/if}
  {#if data.auth?.username}
    <form
      method="POST"
      action="?/submit"
      bind:this={submissionForm}
      class="rounded-xl border border-border bg-card p-4 sm:p-6"
      use:enhance={({ formData }) => {
        rememberDraft(formData);
        renewalRecovered = false;
        sending = true;
        return async ({ update }) => {
          sending = false;
          await update({ reset: false });
          challengeAttempt++;
        };
      }}
    >
      <input type="hidden" name="csrfToken" value={data.auth.csrfToken} />
      <input
        type="hidden"
        name="submissionId"
        value={draftValues?.submissionId || form?.values?.submissionId || data.submissionId}
      />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="submissionMode" value={directIntent ? "direct" : "pending"} />
      <CatalogFields {kind} values={draftValues ?? form?.values ?? {}} />
      <p class="my-4 text-xs leading-6 text-muted-foreground">
        请先搜索现有目录，填写已核实的信息。{data.canPublishDirectly
          ? `直接收录每小时最多${DIRECT_CATALOG_LIMITS.hourly}条、每天${DIRECT_CATALOG_LIMITS.daily}条，不占普通投稿或待审额度。`
          : "每小时最多5条、每天20条，同时待审最多10条。"}同一老师或课程号不重复受理。
      </p>
      {#key challengeAttempt}<Turnstile siteKey={data.turnstileSiteKey} action="submit_catalog" bind:verified />{/key}
      <button
        type="submit"
        class="mt-4 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        disabled={sending || !verified || needsRenewal}
        >{sending ? "正在提交…" : directIntent ? "直接收录并公开" : "提交审核"}</button
      >
    </form>
  {:else if !needsRenewal}
    <div class="rounded-xl border border-border bg-card p-6 text-sm leading-7">
      <p>
        {data.auth ? "请重新登录并设置统一账号用户名，再补充目录。" : "登录统一账号后，可以补充尚未收录的课程和老师。"}
      </p>
      {#if data.authEnabled}<a href={loginUrl} data-sveltekit-reload class="mt-3 inline-flex text-primary"
          >{data.auth ? "重新登录 / 补充资料 →" : "登录后提交 →"}</a
        >{:else}<p class="mt-2 text-muted-foreground">登录暂不可用，请稍后再试。</p>{/if}
    </div>
  {/if}
  {#if data.auth?.username}
    <section class="mt-10" aria-labelledby="my-submissions">
      <h2 id="my-submissions" class="text-xl font-semibold">我的补充 · {data.total} 条</h2>
      <ol class="mt-4 space-y-4">
        {#each data.submissions as item (item.id)}
          <li class="min-w-0 rounded-xl border border-border bg-card p-4 text-sm leading-7 wrap-anywhere">
            <p class="flex flex-wrap justify-between gap-2">
              <span class="font-semibold">{item.kind === "course" ? "课程" : "老师"} · {item.name}</span><span
                class="text-primary">{catalogStatus[item.status]}</span
              >
            </p>
            {#if item.kind === "course"}<p class="text-muted-foreground">
                {item.course_id} · {item.college} · {item.elective_type} · {item.credits} 学分
              </p>{/if}
            <p class="text-xs text-muted-foreground">提交于 {catalogTime(item.created_at)}</p>
            {#if item.note}<p class="mt-2 whitespace-pre-wrap">{item.note}</p>{/if}
            {#if item.reason}<p class="mt-3 border-t border-border pt-2">审核理由：{item.reason}</p>{/if}
            {#if catalogLink(item)}<a href={catalogLink(item)} class="mt-2 inline-flex text-primary">查看已收录条目 →</a
              >{/if}
          </li>
        {:else}<li class="text-sm text-muted-foreground">还没有提交过目录补充。</li>{/each}
      </ol>
      {#if data.pages > 1}<PagePagination
          count={data.total}
          perPage={data.pageSize}
          page={data.page}
          label="我的补充分页"
          {pageUrl}
        />{/if}
    </section>
  {/if}
</main>
