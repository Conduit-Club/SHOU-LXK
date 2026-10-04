<script lang="ts">
import { enhance } from "$app/forms";
import { page } from "$app/state";
import CatalogFields from "#lib/components/catalog-fields.svelte";
import Turnstile from "#lib/components/turnstile.svelte";
import PagePagination from "#lib/components/page-pagination.svelte";
import { catalogStatus, catalogTime, catalogLink } from "#lib/catalog.js";
import type { ActionData, PageData } from "./$types";
let { data, form }: { data: PageData; form: ActionData } = $props();
let sending = $state(false);
let verified = $state(false);
let challengeAttempt = $state(0);
const kind = $derived(
  form?.values?.kind === "teacher" ? "teacher" : form?.values?.kind === "course" ? "course" : data.kind,
);
const pageUrl = (number: number) => `/submissions?${new URLSearchParams({ kind, page: String(number) })}`;
const loginUrl = $derived(`/auth/login?${new URLSearchParams({ returnTo: `${page.url.pathname}?kind=${kind}` })}`);
</script>

<svelte:head><title>补充课程与老师 · SHOU LXK</title><meta name="robots" content="noindex,nofollow" /></svelte:head>
<main id="main-content" class="mx-auto min-w-0 max-w-3xl px-4 py-8 sm:px-6">
  <h1 class="text-2xl font-semibold">补充课程与老师</h1>
  <p class="mt-3 text-sm leading-7 text-muted-foreground">
    目录补充经管理员核实后公开，你可以在此查看审核进度与理由。对已有课程和老师写点评，提交后即公开，无需事先审核。
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
  {#if form?.message}<p class="mb-5 rounded-lg border border-border bg-muted p-4 text-sm" role="alert">
      {form.message}
    </p>{/if}
  {#if data.submitted}<p class="mb-5 rounded-lg border border-border bg-muted p-4 text-sm" role="status">
      补充已收到，审核前不会出现在公开目录。
    </p>{/if}
  {#if data.auth?.username}
    <form
      method="POST"
      action="?/submit"
      class="rounded-xl border border-border bg-card p-4 sm:p-6"
      use:enhance={() => {
        sending = true;
        return async ({ update }) => {
          sending = false;
          await update({ reset: false });
          challengeAttempt++;
        };
      }}
    >
      <input type="hidden" name="csrfToken" value={data.auth.csrfToken} />
      <input type="hidden" name="submissionId" value={form?.values?.submissionId || data.submissionId} />
      <input type="hidden" name="kind" value={kind} />
      <CatalogFields {kind} values={form?.values ?? {}} />
      <p class="my-4 text-xs leading-6 text-muted-foreground">
        请先搜索现有目录，填写已核实的信息。每小时最多5条、每天20条，同时待审最多10条；同一老师或课程号不重复受理。
      </p>
      {#key challengeAttempt}<Turnstile siteKey={data.turnstileSiteKey} action="submit_catalog" bind:verified />{/key}
      <button
        type="submit"
        class="mt-4 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        disabled={sending || !verified}>{sending ? "正在提交…" : "提交审核"}</button
      >
    </form>
  {:else}
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
