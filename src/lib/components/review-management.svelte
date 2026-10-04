<script lang="ts">
import { enhance } from "$app/forms";
import { page } from "$app/state";
import { Button } from "#lib/components/ui/button/index.js";
import type { ReviewKind, ReviewManagement } from "#lib/server/moderation.js";
let {
  reviewId,
  kind,
  management,
  csrfToken,
}: {
  reviewId: number;
  kind: ReviewKind;
  management: ReviewManagement;
  csrfToken: string;
} = $props();
let busy = $state(false);
let message = $state("");
const actionUrl = (action: string) => {
  const params = new URLSearchParams(page.url.search);
  for (const key of [...params.keys()].filter((key) => key.startsWith("/"))) params.delete(key);
  return `?${params}${params.size ? "&" : ""}/${action}`;
};
const submit: import("$app/forms").SubmitFunction = () => {
  busy = true;
  message = "";
  return async ({ result, update }) => {
    try {
      if ((result.type === "success" || result.type === "failure") && typeof result.data?.message === "string")
        message = result.data.message;
      await update({ reset: false });
    } finally {
      busy = false;
    }
  };
};
const key = $derived(`${kind}-${reviewId}`);
</script>

<details class="review-management mt-5 rounded-lg border border-border bg-muted/40 p-4">
  <summary class="cursor-pointer text-sm font-medium text-primary"
    >{management.deleted ? "恢复或管理此点评" : "管理此点评"} · #{reviewId}</summary
  >
  <p class="mt-3 text-xs leading-6 text-muted-foreground">
    {#if management.authorId === null}历史匿名点评，没有可追溯账号。
    {:else}本站账号 #{management.authorId} · {management.authorName ?? "未设置用户名"} · {management.bannedAt
        ? "已封禁"
        : "正常"}
      {#if !management.canBan}
        · 管理员账号受保护{/if}{/if}
  </p>
  {#if management.deleted}<p class="mt-1 text-xs leading-6 text-muted-foreground">删除理由：{management.reason}</p>{/if}
  {#if message}<p class="mt-3 text-sm" role="status">{message}</p>{/if}
  <div class="mt-4 grid gap-5 sm:grid-cols-2">
    <form
      method="POST"
      action={actionUrl(management.deleted ? "restoreReview" : "archiveReview")}
      use:enhance={submit}
      class="flex flex-col gap-2"
    >
      <input type="hidden" name="csrfToken" value={csrfToken} />
      <input type="hidden" name="reviewType" value={kind} />
      <input type="hidden" name="reviewId" value={reviewId} />
      <label for={`review-reason-${key}`} class="text-xs">{management.deleted ? "恢复" : "删除"}理由</label>
      <input
        id={`review-reason-${key}`}
        name="reason"
        maxlength="500"
        required
        disabled={busy}
        class="rounded-md border border-input bg-background px-3 py-2 text-sm"
      />
      <Button type="submit" disabled={busy} variant={management.deleted ? "outline" : "destructive"} class="self-start">
        {management.deleted ? "恢复点评" : "删除点评"}
      </Button>
    </form>
    {#if management.canBan && management.authorId !== null}
      <form
        method="POST"
        action={actionUrl(management.bannedAt ? "unbanUser" : "banUser")}
        use:enhance={submit}
        class="flex flex-col gap-2"
      >
        <input type="hidden" name="csrfToken" value={csrfToken} />
        <input type="hidden" name="userId" value={management.authorId} />
        <label for={`author-reason-${key}`} class="text-xs">{management.bannedAt ? "解封" : "本站封禁"}理由</label>
        <input
          id={`author-reason-${key}`}
          name="reason"
          maxlength="500"
          required
          disabled={busy}
          class="rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <Button type="submit" variant="outline" class="self-start" disabled={busy}>
          {management.bannedAt ? "解除本站封禁" : "在本站封禁作者"}
        </Button>
      </form>
    {/if}
  </div>
</details>
