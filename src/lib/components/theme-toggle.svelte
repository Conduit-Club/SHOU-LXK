<script lang="ts">
import { onMount } from "svelte";
import { Sun, Moon } from "@lucide/svelte";
let light = $state(false);
onMount(() => {
  light = document.documentElement.dataset.theme === "light";
});
function toggle() {
  light = document.documentElement.dataset.theme !== "light";
  document.documentElement.dataset.theme = light ? "light" : "dark";
  try {
    localStorage.setItem("lxk-theme", light ? "light" : "dark");
  } catch {
    /* The theme still works without storage. */
  }
}
</script>

<button
  type="button"
  onclick={toggle}
  aria-label={light ? "切换深色主题" : "切换浅色主题"}
  title={light ? "切换深色主题" : "切换浅色主题"}
  class="theme-toggle flex size-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground hover:text-primary"
>
  {#if light}<Moon class="size-4" aria-hidden="true" />{:else}<Sun class="size-4" aria-hidden="true" />{/if}
</button>
