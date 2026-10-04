<script lang="ts">
import { page } from "$app/state";
let { deleted }: { deleted: boolean } = $props();
const href = (status: string) => {
  const params = new URLSearchParams(page.url.search);
  for (const key of [...params.keys()].filter((key) => key.startsWith("/"))) params.delete(key);
  params.delete("page");
  params.set("status", status);
  return `?${params}`;
};
</script>

<nav
  class="mb-5 flex flex-wrap gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm"
  aria-label="管理模式点评状态"
>
  <span class="font-medium">管理模式</span>
  <a href={href("active")} class:text-primary={!deleted} aria-current={!deleted ? "page" : undefined}>公开中</a>
  <a href={href("deleted")} class:text-primary={deleted} aria-current={deleted ? "page" : undefined}>已删除</a>
  <a href="/admin" class="ml-auto text-primary">完整管理面板 →</a>
</nav>
