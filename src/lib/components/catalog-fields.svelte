<script lang="ts">
import type { CatalogKind } from "#lib/catalog.js";
let {
  kind,
  values = {},
  prefix = "catalog",
  compact = false,
}: {
  kind: CatalogKind;
  values?: Record<string, string | number | null>;
  prefix?: string;
  compact?: boolean;
} = $props();
</script>

<div class="grid min-w-0 gap-4 sm:grid-cols-2">
  <label class="catalog-field sm:col-span-2" for={`${prefix}-name`}>
    <span>{kind === "course" ? "课程名称" : "老师姓名"}</span>
    <input id={`${prefix}-name`} name="name" required maxlength="100" value={values.name ?? ""} autocomplete="off" />
  </label>
  {#if kind === "course"}
    <label class="catalog-field" for={`${prefix}-code`}>
      <span>课程号</span>
      <input
        id={`${prefix}-code`}
        name="courseId"
        required
        maxlength="40"
        value={values.courseId ?? ""}
        autocomplete="off"
        placeholder="与教务系统一致"
      />
    </label>
    <label class="catalog-field" for={`${prefix}-college`}>
      <span>开课学院</span>
      <input
        id={`${prefix}-college`}
        name="college"
        required
        maxlength="100"
        value={values.college ?? ""}
        autocomplete="off"
      />
    </label>
    <label class="catalog-field" for={`${prefix}-type`}>
      <span>课程类型</span>
      <input
        id={`${prefix}-type`}
        name="electiveType"
        required
        maxlength="60"
        value={values.electiveType ?? ""}
        autocomplete="off"
        placeholder="如：选修课"
      />
    </label>
    <label class="catalog-field" for={`${prefix}-credits`}>
      <span>学分</span>
      <input
        id={`${prefix}-credits`}
        name="credits"
        type="number"
        min="0"
        max="30"
        step="any"
        placeholder="如：0.5、1.5、3"
        required
        value={values.credits ?? ""}
      />
    </label>
    <label class="catalog-field sm:col-span-2" for={`${prefix}-lid`}>
      <span>班级号（选填）</span>
      <input id={`${prefix}-lid`} name="lid" maxlength="60" value={values.lid ?? ""} autocomplete="off" />
      <span class="text-xs font-normal text-muted-foreground"
        >未提供真实班级号时，将建立标为“补充收录”的独立条目，供同学评价。</span
      >
    </label>
  {/if}
  {#if !compact}
    <label class="catalog-field sm:col-span-2" for={`${prefix}-note`}>
      <span>补充说明（选填）</span>
      <textarea
        id={`${prefix}-note`}
        name="note"
        maxlength="1000"
        rows="3"
        placeholder="可说明信息来源，帮助管理员核对。请勿填写个人隐私。">{values.note ?? ""}</textarea
      >
    </label>
  {/if}
</div>
