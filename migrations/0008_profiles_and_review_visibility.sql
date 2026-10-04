-- Additive only: historical names, author associations, review IDs, contents,
-- counters and archives stay intact. Existing reviews remain anonymous.
ALTER TABLE auth_users ADD COLUMN username TEXT;
ALTER TABLE auth_users ADD COLUMN avatar_url TEXT;
ALTER TABLE auth_users ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin'));
ALTER TABLE auth_users ADD COLUMN role_expires_at INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX auth_users_username_idx ON auth_users(issuer, username) WHERE username IS NOT NULL;

ALTER TABLE course_reviews ADD COLUMN is_anonymous INTEGER NOT NULL DEFAULT 1 CHECK (is_anonymous IN (0, 1));
ALTER TABLE course_reviews ADD COLUMN public_username TEXT;
ALTER TABLE course_reviews ADD COLUMN public_avatar_url TEXT;
ALTER TABLE teacher_reviews ADD COLUMN is_anonymous INTEGER NOT NULL DEFAULT 1 CHECK (is_anonymous IN (0, 1));
ALTER TABLE teacher_reviews ADD COLUMN public_username TEXT;
ALTER TABLE teacher_reviews ADD COLUMN public_avatar_url TEXT;
ALTER TABLE moderation_review_archive ADD COLUMN is_anonymous INTEGER NOT NULL DEFAULT 1 CHECK (is_anonymous IN (0, 1));
ALTER TABLE moderation_review_archive ADD COLUMN public_username TEXT;
ALTER TABLE moderation_review_archive ADD COLUMN public_avatar_url TEXT;

-- The exception for restoring a banned author's exact original review also
-- compares its publication choice and verified public profile snapshot.
DROP TRIGGER course_reviews_ban_guard;
CREATE TRIGGER course_reviews_ban_guard BEFORE INSERT ON course_reviews
WHEN (SELECT banned_at FROM auth_users WHERE id = NEW.author_id) IS NOT NULL
AND NOT EXISTS (SELECT 1 FROM moderation_review_archive a WHERE a.review_type = 'course'
    AND a.review_id = NEW.id AND a.lid = NEW.lid AND a.author_id IS NEW.author_id
    AND a.title = NEW.title AND a.content = NEW.content AND a.posted_at_local = NEW.posted_at_local
    AND a.is_anonymous = NEW.is_anonymous AND a.public_username IS NEW.public_username
    AND a.public_avatar_url IS NEW.public_avatar_url)
BEGIN SELECT RAISE(ABORT, 'LXK_USER_BANNED'); END;
DROP TRIGGER teacher_reviews_ban_guard;
CREATE TRIGGER teacher_reviews_ban_guard BEFORE INSERT ON teacher_reviews
WHEN (SELECT banned_at FROM auth_users WHERE id = NEW.author_id) IS NOT NULL
AND NOT EXISTS (SELECT 1 FROM moderation_review_archive a WHERE a.review_type = 'teacher'
    AND a.review_id = NEW.id AND a.teacher_id = NEW.teacher_id AND a.author_id IS NEW.author_id
    AND a.title = NEW.title AND a.content = NEW.content AND a.posted_at_local = NEW.posted_at_local
    AND a.is_anonymous = NEW.is_anonymous AND a.public_username IS NEW.public_username
    AND a.public_avatar_url IS NEW.public_avatar_url)
BEGIN SELECT RAISE(ABORT, 'LXK_USER_BANNED'); END;
