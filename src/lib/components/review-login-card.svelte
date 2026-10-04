<script lang="ts">
import { Button } from "#lib/components/ui/button/index.js";
let {
  returnTo,
  enabled,
  needsProfile = false,
}: { returnTo: string; enabled: boolean; needsProfile?: boolean } = $props();
</script>

<section class="mb-8 rounded-xl border border-border bg-card p-5 sm:p-6" aria-label="登录后发表点评">
  <h2 class="font-semibold">{needsProfile ? "补充账号资料后发表点评" : "登录后分享你的课堂体验"}</h2>
  <p class="mt-2 text-sm leading-6 text-muted-foreground">
    {needsProfile
      ? "请重新登录，在统一账号中心设置唯一用户名后继续。"
      : "使用海大统一账号登录或注册，默认匿名发表，也可选择账号用户名。"}本站保存账号关联用于内容管理。
  </p>
  {#if enabled}
    <div class="mt-4 flex items-center gap-3">
      <Button href={`/auth/login?${new URLSearchParams({ returnTo })}`} data-sveltekit-reload
        >{needsProfile ? "重新登录并补充资料" : "登录后写点评"}</Button
      >
      <a href={`/auth/register?${new URLSearchParams({ returnTo })}`} data-sveltekit-reload class="text-sm text-primary"
        >注册统一账号</a
      >
    </div>
  {:else}
    <p class="mt-4 text-sm text-muted-foreground">账号服务暂时不可用，请稍后再来。</p>
  {/if}
</section>
