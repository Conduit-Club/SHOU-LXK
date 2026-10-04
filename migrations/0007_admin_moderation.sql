-- Reviewed-email binding is private; only its normalized SHA-256 hash is kept.
ALTER TABLE auth_users ADD COLUMN verified_email_hash TEXT CHECK (verified_email_hash IS NULL OR length(verified_email_hash) = 64);
ALTER TABLE auth_users ADD COLUMN banned_at INTEGER;
ALTER TABLE auth_users ADD COLUMN ban_reason TEXT;

-- Archived review IDs must never be reused by new comments. Copy the live
-- tables without their triggers, preserving every ID and all existing counters.
CREATE TABLE course_reviews_moderation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lid TEXT NOT NULL REFERENCES course_section(lid),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    posted_at_local TEXT NOT NULL,
    author_id INTEGER REFERENCES auth_users(id) ON DELETE SET NULL
) STRICT;
INSERT INTO course_reviews_moderation SELECT * FROM course_reviews;
CREATE TABLE teacher_reviews_moderation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER NOT NULL REFERENCES teachers(id),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    posted_at_local TEXT NOT NULL,
    author_id INTEGER REFERENCES auth_users(id) ON DELETE SET NULL
) STRICT;
INSERT INTO teacher_reviews_moderation SELECT * FROM teacher_reviews;
DROP TABLE course_reviews;
DROP TABLE teacher_reviews;
ALTER TABLE course_reviews_moderation RENAME TO course_reviews;
ALTER TABLE teacher_reviews_moderation RENAME TO teacher_reviews;

CREATE INDEX course_reviews_lid_idx ON course_reviews(lid);
CREATE INDEX course_reviews_latest_idx ON course_reviews(posted_at_local DESC, id DESC, lid);
CREATE INDEX course_reviews_author_idx ON course_reviews(author_id);
CREATE INDEX teacher_reviews_teacher_posted_idx ON teacher_reviews(teacher_id, posted_at_local, id);
CREATE INDEX teacher_reviews_latest_idx ON teacher_reviews(posted_at_local DESC, id DESC, teacher_id);
CREATE INDEX teacher_reviews_author_idx ON teacher_reviews(author_id);

CREATE TRIGGER course_reviews_count_insert AFTER INSERT ON course_reviews
BEGIN UPDATE course_section SET review_count = review_count + 1 WHERE lid = NEW.lid; END;
CREATE TRIGGER course_reviews_count_delete AFTER DELETE ON course_reviews
BEGIN UPDATE course_section SET review_count = review_count - 1 WHERE lid = OLD.lid; END;
CREATE TRIGGER course_reviews_count_move AFTER UPDATE OF lid ON course_reviews
WHEN NEW.lid <> OLD.lid
BEGIN
    UPDATE course_section SET review_count = review_count - 1 WHERE lid = OLD.lid;
    UPDATE course_section SET review_count = review_count + 1 WHERE lid = NEW.lid;
END;
CREATE TRIGGER site_stats_course_reviews_insert AFTER INSERT ON course_reviews
BEGIN UPDATE site_stats SET reviews = reviews + 1 WHERE id = 1; END;
CREATE TRIGGER site_stats_course_reviews_delete AFTER DELETE ON course_reviews
BEGIN UPDATE site_stats SET reviews = reviews - 1 WHERE id = 1; END;
CREATE TRIGGER site_stats_teacher_reviews_insert AFTER INSERT ON teacher_reviews
BEGIN UPDATE site_stats SET reviews = reviews + 1 WHERE id = 1; END;
CREATE TRIGGER site_stats_teacher_reviews_delete AFTER DELETE ON teacher_reviews
BEGIN UPDATE site_stats SET reviews = reviews - 1 WHERE id = 1; END;

-- Private archive: no FK to the active review, since that row is removed.
CREATE TABLE moderation_review_archive (
    review_type TEXT NOT NULL CHECK (review_type IN ('course', 'teacher')),
    review_id INTEGER NOT NULL CHECK (review_id > 0),
    lid TEXT REFERENCES course_section(lid),
    teacher_id INTEGER REFERENCES teachers(id),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    posted_at_local TEXT NOT NULL,
    author_id INTEGER REFERENCES auth_users(id) ON DELETE SET NULL,
    deleted_by INTEGER NOT NULL,
    deleted_at INTEGER NOT NULL,
    reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
    operation_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY (review_type, review_id),
    CHECK ((review_type = 'course' AND lid IS NOT NULL AND teacher_id IS NULL)
        OR (review_type = 'teacher' AND teacher_id IS NOT NULL AND lid IS NULL))
) STRICT;
CREATE INDEX moderation_review_archive_latest_idx ON moderation_review_archive(review_type, deleted_at DESC, review_id DESC);

CREATE TABLE moderation_events (
    operation_id TEXT PRIMARY KEY,
    actor_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('archive_review', 'restore_review', 'ban_user', 'unban_user')),
    review_type TEXT CHECK (review_type IN ('course', 'teacher')),
    target_id INTEGER NOT NULL CHECK (target_id > 0),
    reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
    created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX moderation_events_latest_idx ON moderation_events(created_at DESC, operation_id);

-- The session/review write itself reads ban state inside its transaction. A
-- request that passed authorization before a concurrent ban cannot create a
-- session or a new review after the ban. An exact archived review may be
-- restored by the protected admin flow, even if its original author is banned.
CREATE TRIGGER auth_sessions_ban_guard BEFORE INSERT ON auth_sessions
WHEN (SELECT banned_at FROM auth_users WHERE id = NEW.user_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'LXK_USER_BANNED'); END;
CREATE TRIGGER auth_sessions_ban_guard_update BEFORE UPDATE OF user_id ON auth_sessions
WHEN (SELECT banned_at FROM auth_users WHERE id = NEW.user_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'LXK_USER_BANNED'); END;
CREATE TRIGGER auth_users_ban_revoke AFTER UPDATE OF banned_at ON auth_users
WHEN NEW.banned_at IS NOT NULL
BEGIN DELETE FROM auth_sessions WHERE user_id = NEW.id; END;
CREATE TRIGGER course_reviews_ban_guard BEFORE INSERT ON course_reviews
WHEN (SELECT banned_at FROM auth_users WHERE id = NEW.author_id) IS NOT NULL
AND NOT EXISTS (SELECT 1 FROM moderation_review_archive a WHERE a.review_type = 'course'
    AND a.review_id = NEW.id AND a.lid = NEW.lid AND a.author_id IS NEW.author_id
    AND a.title = NEW.title AND a.content = NEW.content AND a.posted_at_local = NEW.posted_at_local)
BEGIN SELECT RAISE(ABORT, 'LXK_USER_BANNED'); END;
CREATE TRIGGER teacher_reviews_ban_guard BEFORE INSERT ON teacher_reviews
WHEN (SELECT banned_at FROM auth_users WHERE id = NEW.author_id) IS NOT NULL
AND NOT EXISTS (SELECT 1 FROM moderation_review_archive a WHERE a.review_type = 'teacher'
    AND a.review_id = NEW.id AND a.teacher_id = NEW.teacher_id AND a.author_id IS NEW.author_id
    AND a.title = NEW.title AND a.content = NEW.content AND a.posted_at_local = NEW.posted_at_local)
BEGIN SELECT RAISE(ABORT, 'LXK_USER_BANNED'); END;
