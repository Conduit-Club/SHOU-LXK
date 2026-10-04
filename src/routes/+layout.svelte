<script lang="ts">
import "../app.css";
import { BookOpen, GraduationCap, MessageSquareText, Search, House, Users, LogOut } from "@lucide/svelte";
import { page } from "$app/state";
import type { Snippet } from "svelte";
import type { LayoutData } from "./$types";
import ThemeToggle from "#lib/components/theme-toggle.svelte";
import ReviewAuthor from "#lib/components/review-author.svelte";
let { children, data }: { children: Snippet; data: LayoutData } = $props();
const returnTo = $derived(`${page.url.pathname}${page.url.search}`);
const authLink = (intent: "login" | "register") => `/auth/${intent}?${new URLSearchParams({ returnTo })}`;
</script>

<a
  href="#main-content"
  class="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-md focus:bg-background focus:p-3"
  >跳转到主要内容</a
>
<header class="site-header sticky top-0 z-40 border-b">
  <nav class="site-shell mx-auto max-w-6xl px-4 py-3 sm:px-6" aria-label="主导航">
    <div class="site-header-top">
      <a href="/" class="flex min-w-0 items-center gap-3 no-underline">
        <span class="site-brand-mark flex size-9 items-center justify-center rounded-lg"
          ><GraduationCap class="size-5" aria-hidden="true" /></span
        >
        <span class="flex min-w-0 flex-col gap-0.5 whitespace-nowrap"
          ><span class="text-sm font-bold tracking-wide text-foreground">SHOU LXK</span><span
            class="text-xs text-muted-foreground">上海海洋大学课程评价</span
          ></span
        >
      </a>
      <ThemeToggle />
    </div>

    <div class="site-navigation">
      <div class="site-links">
        {#each [{ href: "/", label: "首页", icon: House }, { href: "/reviews", label: "点评", icon: MessageSquareText }, { href: "/courses", label: "课程", icon: BookOpen }, { href: "/teachers", label: "老师", icon: Users }] as item}
          <a
            href={item.href}
            aria-current={(item.href === "/" ? page.url.pathname === "/" : page.url.pathname.startsWith(item.href))
              ? "page"
              : undefined}
            class="site-nav-link flex min-h-10 min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-1 text-sm font-medium sm:px-3"
            ><item.icon class="size-4 shrink-0" aria-hidden="true" /><span>{item.label}</span></a
          >
        {/each}
      </div>

      <form
        action="/courses"
        method="GET"
        role="search"
        class="top-search flex min-w-0 items-center overflow-hidden rounded-md"
      >
        <label for="global-search" class="sr-only">搜索课程或课程号</label>
        <input
          id="global-search"
          name="q"
          type="search"
          placeholder="搜索课程或课程号"
          maxlength="100"
          class="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        <button
          type="submit"
          class="flex size-9 shrink-0 items-center justify-center bg-primary text-primary-foreground transition-opacity hover:opacity-85"
          aria-label="搜索"><Search class="size-4" aria-hidden="true" /></button
        >
      </form>
    </div>
    <div class="site-account text-sm">
      {#if data.auth}
        {#if data.auth.isAdmin}
          <a href="/admin" class="inline-flex min-h-9 items-center whitespace-nowrap font-medium text-primary">管理</a>
          <form method="POST" action="/admin/mode">
            <input type="hidden" name="csrfToken" value={data.auth.csrfToken} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <input type="hidden" name="enabled" value={data.managementMode ? "0" : "1"} />
            <button
              type="submit"
              aria-pressed={data.managementMode}
              class="min-h-9 whitespace-nowrap rounded-md border border-border px-2 py-1.5 text-xs text-primary"
            >
              管理模式{data.managementMode ? "：开" : "：关"}
            </button>
          </form>
        {:else if data.auth.canRenewAdmin}
          <a
            href={authLink("login")}
            data-sveltekit-reload
            class="inline-flex min-h-9 items-center whitespace-nowrap text-xs text-primary">验证管理权限</a
          >
        {/if}
        <a
          href="https://auth.shoumc.com/account"
          class="flex min-h-9 min-w-0 max-w-36 items-center gap-1.5 text-muted-foreground hover:text-primary"
          aria-label="打开统一账号中心"
        >
          <ReviewAuthor identity={{ display_name: data.auth.name, avatar_url: data.auth.avatarUrl }} />
        </a>
        <form method="POST" action="/auth/logout">
          <input type="hidden" name="csrfToken" value={data.auth.csrfToken} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <button
            type="submit"
            class="flex min-h-9 items-center gap-1.5 whitespace-nowrap text-muted-foreground hover:text-primary"
            aria-label="退出本站登录"
            ><LogOut class="size-4" aria-hidden="true" /><span class="hidden sm:inline">退出</span></button
          >
        </form>
      {:else if data.authEnabled}
        <a
          href={authLink("login")}
          data-sveltekit-reload
          class="inline-flex min-h-9 items-center font-medium text-primary">登录</a
        >
        <a
          href={authLink("register")}
          data-sveltekit-reload
          class="inline-flex min-h-9 items-center text-muted-foreground hover:text-primary">注册</a
        >
      {:else}
        <span class="text-xs text-muted-foreground">登录暂不可用</span>
      {/if}
    </div>
  </nav>
</header>
{@render children()}
<footer
  class="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 py-8 text-xs text-muted-foreground sm:flex-row sm:px-6"
>
  <p>SHOU LXK · 上海海洋大学课程评价</p>
  <p>分享课堂体验，让选课多一份参考。</p>
</footer>
