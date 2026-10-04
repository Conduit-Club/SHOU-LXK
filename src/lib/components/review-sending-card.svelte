<script lang="ts">
import { sectionLabel } from "#lib/catalog.js";
import Turnstile from "#lib/components/turnstile.svelte";
import { Button } from "#lib/components/ui/button/index.js";
import * as Field from "#lib/components/ui/field/index.js";
import { Input } from "#lib/components/ui/input/index.js";
import { Textarea } from "#lib/components/ui/textarea/index.js";

type Section = { lid: string; teachers: { name: string }[] };
type FormData = { message?: string; title?: string; content?: string; lid?: string; visibility?: string } | null;

let {
  heading,
  turnstileSiteKey,
  form,
  sections,
  selectedLid,
  csrfToken,
  username,
  id,
}: {
  heading: string;
  turnstileSiteKey: string;
  form: FormData;
  sections?: Section[];
  selectedLid?: string;
  csrfToken: string;
  username: string;
  id?: string;
} = $props();
let verified = $state(false);
</script>

<section
  {id}
  class="mb-10 rounded-xl border border-border bg-card p-5 shadow-xs sm:p-6"
  aria-labelledby="review-form-title"
>
  <h2 id="review-form-title" class="text-lg font-semibold tracking-tight">{heading}</h2>
  <form method="POST" action="?/submitReview" class="mt-5">
    <input type="hidden" name="csrfToken" value={csrfToken} />
    <p class="mb-5 text-sm leading-6 text-muted-foreground">
      点评提交后即公开，无需事先审核。默认匿名发表，也可使用统一账号用户名。本站保存账号关联用于内容管理，请勿填写个人联系方式。
    </p>
    <Field.Group>
      <fieldset class="space-y-3 rounded-lg border border-border p-4">
        <legend class="px-1 text-sm font-medium">发表身份</legend>
        <label class="flex items-center gap-2 text-sm"
          ><input
            type="radio"
            name="visibility"
            value="anonymous"
            checked={form?.visibility !== "username"}
          />匿名用户（隐藏用户名与头像）</label
        >
        <label class="flex items-center gap-2 text-sm"
          ><input
            type="radio"
            name="visibility"
            value="username"
            checked={form?.visibility === "username"}
          />使用账号用户名：{username}</label
        >
      </fieldset>
      {#if sections}
        {#if selectedLid || sections.length === 1}
          <input type="hidden" name="lid" value={selectedLid ?? sections[0].lid} />
        {:else}
          <Field.Field data-invalid={form?.message ? true : undefined}>
            <Field.Label for="review-section">课程课段</Field.Label>
            <select
              id="review-section"
              name="lid"
              required
              class="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-9 rounded-md border px-2.5 text-sm shadow-xs outline-none focus-visible:ring-3"
              value={form?.lid ?? ""}
            >
              <option value="" disabled>请选择课程课段</option>
              {#each sections as choice (choice.lid)}
                <option value={choice.lid}
                  >{choice.teachers.map((teacher) => teacher.name).join("、") || "教师信息待补充"} · {sectionLabel(
                    choice.lid,
                  )}</option
                >
              {/each}
            </select>
          </Field.Field>
        {/if}
      {/if}
      <Field.Field data-invalid={form?.message ? true : undefined}>
        <Field.Label for="review-title">标题</Field.Label>
        <Input
          id="review-title"
          name="title"
          maxlength={120}
          required
          value={form?.title ?? ""}
          aria-invalid={form?.message ? true : undefined}
        />
      </Field.Field>
      <Field.Field data-invalid={form?.message ? true : undefined}>
        <Field.Label for="review-content">正文</Field.Label>
        <Textarea
          id="review-content"
          name="content"
          rows={5}
          maxlength={5000}
          required
          value={form?.content ?? ""}
          aria-invalid={form?.message ? true : undefined}
        />
      </Field.Field>
      {#if form?.message}
        <p class="text-sm text-destructive" role="alert">{form.message}</p>
      {/if}
      <Turnstile siteKey={turnstileSiteKey} bind:verified />
      <Button type="submit" class="self-start" disabled={!verified}>提交评价</Button>
    </Field.Group>
  </form>
</section>
