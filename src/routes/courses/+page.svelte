<script lang="ts">
import TeacherLinks from "#lib/components/teacher-links.svelte";
import { resolve } from "$app/paths";
import { goto } from "$app/navigation";
import {
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  LoaderCircle,
  MessageSquareText,
  Search,
  SlidersHorizontal,
  Users,
} from "@lucide/svelte";
import { Button } from "#lib/components/ui/button/index.js";
import { Input } from "#lib/components/ui/input/index.js";
import { InputGroup, InputGroupAddon, InputGroupInput } from "#lib/components/ui/input-group/index.js";
import * as Select from "#lib/components/ui/select/index.js";
import * as Field from "#lib/components/ui/field/index.js";
import * as Empty from "#lib/components/ui/empty/index.js";
import { Badge } from "#lib/components/ui/badge/index.js";
import PagePagination from "#lib/components/page-pagination.svelte";
import type { PageData } from "./$types";

let { data }: { data: PageData } = $props();
let isLoading = $state(false);
// svelte-ignore state_referenced_locally
let selectValues = $state({ ...data.filters });

async function submitSearch(event: SubmitEvent) {
  event.preventDefault();
  if (isLoading) return;

  const form = event.currentTarget as HTMLFormElement;
  const params = new URLSearchParams(Array.from(new FormData(form), ([key, value]) => [key, String(value)]));
  const url = new URL(form.action);
  url.search = params.toString();
  isLoading = true;
  try {
    await goto(url);
  } finally {
    isLoading = false;
  }
}

$effect(() => {
  Object.assign(selectValues, data.filters);
});

const pageUrl = (page: number) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data.filters)) {
    if (value && !(key === "sort" && value === "reviews")) params.set(key, value);
  }
  params.set("page", String(page));
  return `/courses?${params}`;
};

const sectionUrl = (courseId: string, lid: string) => {
  const params = new URLSearchParams({ lid });
  return `${resolve("/courses/[courseId]", { courseId })}?${params}`;
};

const hasAdvancedFilters = $derived(
  Boolean(data.filters.teacher || data.filters.attribute || data.filters.credits || data.filters.minReviews),
);

const primaryFilters = $derived([
  {
    key: "sort" as const,
    label: "排序",
    placeholder: "最多评价",
    options: [
      { value: "reviews", label: "最多评价" },
      { value: "name", label: "课程名称" },
      { value: "credits", label: "最多学分" },
    ],
  },
  {
    key: "electiveType" as const,
    label: "课程类型",
    placeholder: "全部类型",
    options: data.options.electiveTypes.map((value) => ({ value, label: value })),
  },
  {
    key: "college" as const,
    label: "开课学院",
    placeholder: "全部学院",
    options: data.options.colleges.map((value) => ({ value, label: value })),
  },
]);
const extraFilters = $derived([
  { key: "credits" as const, label: "学分", options: data.options.credits.map(String) },
  { key: "attribute" as const, label: "课程属性", options: data.options.attributes },
]);
</script>

<svelte:head
  ><title>课程 · SHOU LXK</title><meta
    name="description"
    content="搜索课程名称或课程号，按学院、教师和学分筛选上海海洋大学课程。"
  /></svelte:head
>
<main id="main-content" class="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
  <section id="course-catalog" aria-labelledby="course-catalog-heading">
    <header class="section-heading">
      <div>
        <p class="mb-2 text-xs tracking-widest text-muted-foreground">课程与班级</p>
        <h1 id="course-catalog-heading" class="text-2xl font-semibold sm:text-3xl">浏览课程</h1>
      </div>
      <div class="flex flex-wrap items-center gap-3 text-sm">
        <p class="text-muted-foreground">共 {data.total.toLocaleString()} 个课段</p>
        <a href="/submissions?kind=course" class="text-primary hover:underline">补充课程 / 课程号 →</a>
      </div>
    </header>

    <form method="GET" action="/courses" role="search" onsubmit={submitSearch} class="filter-card flex flex-col gap-4">
      <Field.Group>
        <Field.Field>
          <Field.Label for="course-search" class="sr-only">课程名或课程号</Field.Label>
          <div class="flex gap-2">
            <InputGroup class="min-w-0 flex-1">
              <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
              <InputGroupInput id="course-search" name="q" value={data.filters.q} placeholder="搜索课程名或课程号" />
            </InputGroup>
            <Button type="submit" disabled={isLoading}>
              {#if isLoading}<LoaderCircle data-icon="inline-start" class="animate-spin" aria-hidden="true" />{/if}
              {isLoading ? "搜索中…" : "搜索"}
            </Button>
          </div>
        </Field.Field>
      </Field.Group>
      <div class="flex flex-col gap-4 rounded-md bg-muted/60 p-3 sm:p-4">
        <Field.Group class="grid gap-4 lg:grid-cols-3">
          {#each primaryFilters as filter (filter.key)}
            <Field.Field orientation="horizontal" class="min-w-0 items-center">
              <Field.Label for={filter.key} class="grow-0!">{filter.label}</Field.Label>
              <Select.Root type="single" name={filter.key} bind:value={selectValues[filter.key]}>
                <Select.Trigger id={filter.key} class="min-w-0 flex-1">
                  <Select.Value
                    >{filter.options.find((option) => option.value === selectValues[filter.key])?.label ||
                      filter.placeholder}</Select.Value
                  >
                </Select.Trigger>
                <Select.Content
                  ><Select.Group>
                    {#if filter.key !== "sort"}<Select.Item value="" label={filter.placeholder}
                        >{filter.placeholder}</Select.Item
                      >{/if}
                    {#each filter.options as option}<Select.Item value={option.value} label={option.label}
                        >{option.label}</Select.Item
                      >{/each}
                  </Select.Group></Select.Content
                >
              </Select.Root>
            </Field.Field>
          {/each}
        </Field.Group>
        <details open={hasAdvancedFilters}>
          <summary
            class="flex w-fit cursor-pointer items-center gap-2 text-sm text-muted-foreground hover:text-primary"
          >
            <SlidersHorizontal class="size-4" aria-hidden="true" />更多筛选
          </summary>
          <Field.Group class="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field.Field
              ><Field.Label for="teacher">授课教师</Field.Label><Input
                id="teacher"
                name="teacher"
                value={data.filters.teacher}
                placeholder="教师姓名"
              /></Field.Field
            >
            {#each extraFilters as filter (filter.key)}
              <Field.Field
                ><Field.Label for={filter.key}>{filter.label}</Field.Label>
                <Select.Root type="single" name={filter.key} bind:value={selectValues[filter.key]}>
                  <Select.Trigger id={filter.key} class="w-full"
                    ><Select.Value>{selectValues[filter.key] || "不限"}</Select.Value></Select.Trigger
                  >
                  <Select.Content
                    ><Select.Group>
                      <Select.Item value="" label="不限">不限</Select.Item>
                      {#each filter.options as option}<Select.Item value={option} label={option}>{option}</Select.Item
                        >{/each}
                    </Select.Group></Select.Content
                  >
                </Select.Root>
              </Field.Field>
            {/each}
            <Field.Field
              ><Field.Label for="minReviews">最少评价数</Field.Label><Input
                id="minReviews"
                name="minReviews"
                type="number"
                min="0"
                step="1"
                value={data.filters.minReviews}
                placeholder="不限"
              /></Field.Field
            >
          </Field.Group>
        </details>
      </div>
      <div class="flex items-center justify-between gap-3">
        <p class="text-xs text-muted-foreground">{data.isSearching ? "已按条件筛选课程" : "按同学评价数量排序"}</p>
        <div class="flex gap-2">
          <Button type="submit" variant="outline" size="sm" disabled={isLoading}>应用筛选</Button>
          <Button href="/courses" variant="ghost" size="sm">重置</Button>
        </div>
      </div>
    </form>

    <div class="course-list-card" aria-busy={isLoading}>
      <header>
        <div>
          <h3>课程列表</h3>
          <p class="mt-1">课程名、教师、学院与学分均可筛选</p>
        </div>
        <a class="inline-flex items-center gap-1 text-sm text-primary" href="#course-search"
          >调整筛选 <ChevronRight class="size-4" aria-hidden="true" /></a
        >
      </header>
      <span class="sr-only" role="status">{isLoading ? "正在加载课程结果" : `共 ${data.total} 个课程班级`}</span>
      {#if data.sections.length}
        <ol>
          {#each data.sections as section, index (section.lid)}
            <li
              class:border-b={index < data.sections.length - 1}
              class:border-border={index < data.sections.length - 1}
            >
              <article
                class="course-row group flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
              >
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <h4 class="text-lg font-semibold leading-snug text-primary">
                      <a class="wrap-anywhere hover:underline" href={sectionUrl(section.course_id, section.lid)}
                        >{section.name}</a
                      >
                    </h4>
                    <Badge variant="secondary">{section.course_id}</Badge>
                  </div>
                  <div class="mt-2 flex items-start gap-2 text-sm text-muted-foreground">
                    <Users class="mt-0.5 size-4 shrink-0" aria-hidden="true" /><TeacherLinks
                      teachers={section.teachers}
                    />
                  </div>
                  <dl class="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
                    <div class="flex gap-2">
                      <dt>学院</dt>
                      <dd class="text-foreground">{section.college}</dd>
                    </div>
                    {#if section.elective_type && section.elective_type !== "N/A"}<div class="flex gap-2">
                        <dt>类型</dt>
                        <dd class="text-foreground">{section.elective_type}</dd>
                      </div>{/if}
                    <div class="flex gap-2">
                      <dt>学分</dt>
                      <dd class="font-medium tabular-nums text-foreground">{section.credits}</dd>
                    </div>
                  </dl>
                </div>
                <div class="flex shrink-0 items-center justify-between gap-6 sm:justify-end">
                  <div class="flex items-center gap-2 text-sm text-muted-foreground">
                    <MessageSquareText class="size-4 text-primary" aria-hidden="true" /><span
                      ><strong class="font-semibold tabular-nums text-foreground">{section.review_count}</strong> 条评价</span
                    >
                  </div>
                  <Button
                    href={sectionUrl(section.course_id, section.lid)}
                    variant="ghost"
                    size="icon"
                    aria-label={`查看${section.name}的课程评价`}
                  >
                    <ArrowUpRight aria-hidden="true" />
                  </Button>
                </div>
              </article>
            </li>
          {/each}
        </ol>
      {:else}
        <Empty.Root class="py-16"
          ><Empty.Header
            ><Empty.Media variant="icon"><BookOpen /></Empty.Media><Empty.Title>没有找到课程</Empty.Title
            ><Empty.Description>试试其他关键词，或放宽筛选条件。</Empty.Description></Empty.Header
          ><Empty.Content><Button href="/courses" variant="outline">查看全部课程</Button></Empty.Content></Empty.Root
        >
      {/if}
      <footer class="border-t border-border px-5 py-4 text-center">
        {#if data.pages > 1}
          <PagePagination count={data.total} perPage={data.pageSize} page={data.page} label="课程页面" {pageUrl} />
        {:else}<p class="text-xs text-muted-foreground">
            {data.sections.length ? "已显示全部课程" : "暂无匹配结果"}
          </p>{/if}
      </footer>
    </div>
  </section>
</main>
