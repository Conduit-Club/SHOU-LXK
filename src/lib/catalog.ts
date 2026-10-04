export type CatalogKind = "course" | "teacher";
export type CatalogDraft = {
  kind: CatalogKind;
  name: string;
  courseId: string | null;
  college: string | null;
  electiveType: string | null;
  credits: number | null;
  lid: string | null;
  note: string;
};
export type CatalogSubmission = {
  id: string;
  kind: CatalogKind;
  name: string;
  course_id: string | null;
  college: string | null;
  elective_type: string | null;
  credits: number | null;
  lid: string | null;
  note: string;
  status: "pending" | "approved" | "rejected";
  created_at: number;
  reviewed_at: number | null;
  reviewed_by: number | null;
  reason: string | null;
  published_course_id: string | null;
  published_lid: string | null;
  published_teacher_id: number | null;
  approved_payload: string | null;
};

export const catalogStatus = { pending: "待审核", approved: "已收录", rejected: "未通过" };
export const catalogTime = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
export const catalogLink = (item: CatalogSubmission) =>
  item.published_teacher_id
    ? `/teachers/${item.published_teacher_id}`
    : item.published_course_id && item.published_lid
      ? `/courses/${encodeURIComponent(item.published_course_id)}?${new URLSearchParams({ lid: item.published_lid })}`
      : null;

export const sectionLabel = (lid: string) => (lid.startsWith("community-") ? "补充收录" : `班级 ${lid}`);
