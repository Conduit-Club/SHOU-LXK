<script lang="ts">
import DirectorySearch from "#lib/components/directory-search.svelte";
import PagePagination from "#lib/components/page-pagination.svelte";
import { ArrowUpRight, Users } from "@lucide/svelte";
import type { PageData } from "./$types";
let { data }: { data: PageData } = $props();
const pageUrl = (page: number) => `/teachers?${new URLSearchParams({ q: data.q, page: String(page) })}`;
</script>

<svelte:head
  ><title>老师 · SHOU LXK</title><meta
    name="description"
    content="查找上海海洋大学老师，浏览授课信息和教师点评。"
  /></svelte:head
>
<main id="main-content" class="directory-page">
  <header class="section-heading">
    <div>
      <p class="eyebrow">MEET YOUR TEACHERS / 老师</p>
      <h1 class="text-3xl font-semibold sm:text-4xl">从名字，走近一堂课。</h1>
      <p class="mt-3 text-sm text-muted-foreground">查找授课信息，了解同学眼中的老师。</p>
    </div>
    <div class="flex flex-wrap items-center gap-3 text-sm">
      <span class="count-note">{data.total.toLocaleString()} 位老师</span><a
        href="/submissions?kind=teacher"
        class="text-primary hover:underline">补充老师 →</a
      >
    </div>
  </header>
  <DirectorySearch action="/teachers" q={data.q} label="搜索老师" placeholder="输入老师姓名" />
  <div class="teacher-directory mt-6">
    {#each data.teachers as teacher (teacher.id)}<a class="teacher-tile" href={`/teachers/${teacher.id}`}
        ><span class="teacher-monogram" aria-hidden="true">{teacher.name.slice(0, 1)}</span>
        <div>
          <h2>{teacher.name}</h2>
          <p>授课信息与点评</p>
        </div>
        <ArrowUpRight class="ml-auto size-4 text-primary" aria-hidden="true" /></a
      >{:else}<div class="directory-empty col-span-full">
        <Users class="size-8" aria-hidden="true" />
        <h2>没有找到这位老师</h2>
        <p>试试姓名的一部分，或查看全部老师。</p>
        <a href="/teachers">查看所有老师 →</a>
      </div>{/each}
  </div>
  {#if data.pages > 1}<PagePagination
      count={data.total}
      perPage={data.pageSize}
      page={data.page}
      label="老师页面"
      {pageUrl}
    />{/if}
</main>
