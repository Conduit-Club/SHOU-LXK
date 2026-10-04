<script lang="ts">
import { UserRound } from "@lucide/svelte";
import type { PublicReviewIdentity } from "#lib/server/review-identity.js";
let { identity }: { identity: PublicReviewIdentity } = $props();
let failedUrl = $state<string | null>(null);
</script>

<span class="inline-flex min-w-0 items-center gap-2 text-sm">
  {#if identity.avatar_url && failedUrl !== identity.avatar_url}
    <img
      src={identity.avatar_url}
      alt=""
      width="34"
      height="34"
      loading="lazy"
      referrerpolicy="no-referrer"
      class="size-8.5 shrink-0 rounded-full object-cover"
      onerror={() => (failedUrl = identity.avatar_url)}
    />
  {:else}
    <span class="review-avatar" aria-hidden="true">
      {#if identity.display_name === "匿名用户"}<UserRound class="size-4" />{:else}{identity.display_name.slice(
          0,
          1,
        )}{/if}
    </span>
  {/if}
  <span class="truncate">{identity.display_name}</span>
</span>
