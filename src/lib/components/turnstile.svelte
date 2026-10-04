<script lang="ts">
import { page } from "$app/state";
import { Button } from "#lib/components/ui/button/index.js";
import { loadTurnstile } from "#lib/turnstile.js";

let {
  siteKey,
  action = "submit_review",
  verified = $bindable(false),
}: { siteKey: string; action?: string; verified?: boolean } = $props();
let container: HTMLDivElement;
let message = $state("");
let attempt = $state(0);

$effect(() => {
  const key = siteKey;
  // A reused review card needs a fresh challenge when navigating to another course or teacher.
  void page.url.pathname;
  void attempt;
  verified = false;
  message = key ? "" : "验证服务暂时不可用，请稍后重试。";
  if (!key) return;

  let disposed = false;
  let remove: (() => void) | undefined;
  let observer: ResizeObserver | undefined;
  void loadTurnstile()
    .then((api) => {
      if (disposed) return;
      let renderedSize: "compact" | "flexible" | undefined;
      const renderForWidth = () => {
        const size = container.clientWidth < 300 ? "compact" : "flexible";
        if (disposed || renderedSize === size) return;
        renderedSize = size;
        verified = false;
        remove?.();
        const widgetId = api.render(container, {
          sitekey: key,
          action,
          size,
          callback: () => {
            verified = true;
            message = "";
          },
          "expired-callback": () => {
            verified = false;
          },
          "timeout-callback": () => {
            verified = false;
          },
          "error-callback": () => {
            verified = false;
            message = "人机验证失败，请重试。";
          },
        });
        remove = () => api.remove(widgetId);
      };
      renderForWidth();
      observer = new ResizeObserver(renderForWidth);
      observer.observe(container);
    })
    .catch(() => {
      if (!disposed) {
        verified = false;
        message = "无法加载人机验证，请检查网络后重试。";
      }
    });

  return () => {
    disposed = true;
    observer?.disconnect();
    remove?.();
    verified = false;
  };
});
</script>

<div bind:this={container}></div>
{#if message}
  <p class="text-sm text-destructive" role="alert">{message}</p>
  {#if siteKey}
    <Button type="button" variant="outline" size="sm" class="self-start" onclick={() => attempt++}>重试验证</Button>
  {/if}
{/if}
<noscript><p class="text-sm text-destructive">请启用 JavaScript 以完成人机验证并提交。</p></noscript>
