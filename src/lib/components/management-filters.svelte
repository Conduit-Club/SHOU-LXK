<script lang="ts">
import { Button } from "#lib/components/ui/button/index.js";
import type { moderationFilters } from "#lib/server/moderation.js";
let { action, filters }: { action: string; filters: ReturnType<typeof moderationFilters> } = $props();
const inputClass = "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm";
</script>

<form
  method="GET"
  {action}
  class="my-6 grid gap-4 rounded-xl border border-border bg-card p-5 sm:grid-cols-2 lg:grid-cols-4"
  aria-label="点评管理筛选"
>
  <label class="space-y-2 text-xs"
    >点评标题或正文<input
      name="q"
      type="search"
      maxlength="100"
      value={filters.q}
      placeholder="搜索点评内容"
      class={inputClass}
    /></label
  >
  <label class="space-y-2 text-xs"
    >课程或教师<input
      name="target"
      type="search"
      maxlength="100"
      value={filters.target}
      placeholder="课程名、课程号、教师名"
      class={inputClass}
    /></label
  >
  <label class="space-y-2 text-xs"
    >点评作者<input
      name="author"
      type="search"
      maxlength="100"
      value={filters.author}
      placeholder="账号用户名或本站账号编号"
      class={inputClass}
    /></label
  >
  <label class="space-y-2 text-xs"
    >点评类型<select name="type" value={filters.kind} class={inputClass}
      ><option value="all">全部类型</option><option value="course">课程点评</option><option value="teacher"
        >教师点评</option
      ></select
    ></label
  >
  <label class="space-y-2 text-xs"
    >展示状态<select name="status" value={filters.status} class={inputClass}
      ><option value="active">公开中</option><option value="deleted">已删除</option></select
    ></label
  >
  <label class="space-y-2 text-xs"
    >作者关联<select name="ownership" value={filters.ownership} class={inputClass}
      ><option value="all">全部作者</option><option value="known">有账号关联</option><option value="legacy"
        >无账号关联</option
      ></select
    ></label
  >
  <label class="space-y-2 text-xs"
    >本站封禁<select name="banned" value={filters.banned} class={inputClass}
      ><option value="all">全部状态</option><option value="yes">作者已封禁</option><option value="no">作者未封禁</option
      ></select
    ></label
  >
  <div class="flex items-end gap-3">
    <Button type="submit">搜索与筛选</Button><a href={action} class="pb-2 text-sm text-primary">清空</a>
  </div>
</form>
