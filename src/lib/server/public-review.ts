export type PublicReviewIdentity = { display_name: string; avatar_url: string | null };
// Anonymous rows deliberately never project their stored attribution/avatar.
export const publicReviewProjection = (prefix = "") =>
  `CASE WHEN ${prefix}is_anonymous=0 THEN COALESCE(${prefix}public_username,'匿名用户') ELSE '匿名用户' END AS display_name,
   CASE WHEN ${prefix}is_anonymous=0 THEN ${prefix}public_avatar_url ELSE NULL END AS avatar_url`;
