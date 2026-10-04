PRAGMA foreign_keys = ON;

CREATE TABLE courses (
    course_id TEXT PRIMARY KEY,
    name TEXT NOT NULL
) STRICT;

CREATE INDEX courses_name_idx ON courses(name COLLATE NOCASE, course_id);

CREATE TABLE course_section (
    lid TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(course_id),
    college TEXT NOT NULL,
    elective_type TEXT NOT NULL,
    credits INTEGER NOT NULL CHECK (credits >= 0),
    attribute TEXT,
    likes INTEGER NOT NULL DEFAULT 0 CHECK (likes >= 0),
    dislikes INTEGER NOT NULL DEFAULT 0 CHECK (dislikes >= 0),
    review_count INTEGER NOT NULL DEFAULT 0 CHECK (review_count >= 0)
) STRICT;

CREATE INDEX course_section_course_id_idx ON course_section(course_id, lid);
CREATE INDEX course_section_college_idx ON course_section(college);
CREATE INDEX course_section_review_count_idx ON course_section(review_count DESC);
CREATE INDEX course_section_elective_type_idx ON course_section(elective_type, review_count DESC);
CREATE INDEX course_section_credits_idx ON course_section(credits, review_count DESC);
CREATE INDEX course_section_attribute_idx ON course_section(trim(attribute), review_count DESC);
CREATE INDEX course_section_college_credits_idx ON course_section(college, credits);

CREATE TABLE teachers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0)
) STRICT;

-- A business-site identity, keyed by the OIDC issuer and stable subject. Email
-- and upstream tokens are not persisted or exposed as review author details.
CREATE TABLE auth_users (
    id INTEGER PRIMARY KEY,
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER NOT NULL,
    verified_email_hash TEXT CHECK (verified_email_hash IS NULL OR length(verified_email_hash) = 64),
    banned_at INTEGER,
    ban_reason TEXT,
    username TEXT,
    avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    role_expires_at INTEGER NOT NULL DEFAULT 0,
    UNIQUE (issuer, subject)
) STRICT;

CREATE UNIQUE INDEX auth_users_username_idx ON auth_users(issuer, username) WHERE username IS NOT NULL;

CREATE TABLE auth_sessions (
    token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
    user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL CHECK (expires_at > created_at)
) STRICT;
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);

CREATE TABLE auth_login_transactions (
    state_hash TEXT PRIMARY KEY CHECK (length(state_hash) = 64),
    browser_hash TEXT NOT NULL CHECK (length(browser_hash) = 64),
    verifier TEXT NOT NULL,
    nonce TEXT NOT NULL,
    return_to TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL CHECK (expires_at > created_at)
) STRICT;
CREATE INDEX auth_login_transactions_expiry_idx ON auth_login_transactions(expires_at);

CREATE TABLE course_section_teachers (
    lid TEXT NOT NULL REFERENCES course_section(lid),
    teacher_id INTEGER NOT NULL REFERENCES teachers(id),
    position INTEGER NOT NULL CHECK (position >= 1),
    PRIMARY KEY (lid, teacher_id),
    UNIQUE (lid, position)
) WITHOUT ROWID, STRICT;

CREATE INDEX course_section_teachers_teacher_idx ON course_section_teachers(teacher_id, lid);

CREATE TABLE course_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lid TEXT NOT NULL REFERENCES course_section(lid),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    posted_at_local TEXT NOT NULL,
    author_id INTEGER REFERENCES auth_users(id) ON DELETE SET NULL,
    is_anonymous INTEGER NOT NULL DEFAULT 1 CHECK (is_anonymous IN (0, 1)),
    public_username TEXT,
    public_avatar_url TEXT
) STRICT;

CREATE INDEX course_reviews_lid_idx ON course_reviews(lid);
CREATE INDEX course_reviews_latest_idx ON course_reviews(posted_at_local DESC, id DESC, lid);
CREATE INDEX course_reviews_author_idx ON course_reviews(author_id);

CREATE TRIGGER course_reviews_count_insert AFTER INSERT ON course_reviews
BEGIN
    UPDATE course_section SET review_count = review_count + 1 WHERE lid = NEW.lid;
END;

CREATE TRIGGER course_reviews_count_delete AFTER DELETE ON course_reviews
BEGIN
    UPDATE course_section SET review_count = review_count - 1 WHERE lid = OLD.lid;
END;

CREATE TRIGGER course_reviews_count_move AFTER UPDATE OF lid ON course_reviews
WHEN NEW.lid <> OLD.lid
BEGIN
    UPDATE course_section SET review_count = review_count - 1 WHERE lid = OLD.lid;
    UPDATE course_section SET review_count = review_count + 1 WHERE lid = NEW.lid;
END;

CREATE TABLE teacher_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER NOT NULL REFERENCES teachers(id),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    posted_at_local TEXT NOT NULL,
    author_id INTEGER REFERENCES auth_users(id) ON DELETE SET NULL,
    is_anonymous INTEGER NOT NULL DEFAULT 1 CHECK (is_anonymous IN (0, 1)),
    public_username TEXT,
    public_avatar_url TEXT
) STRICT;

CREATE INDEX teacher_reviews_teacher_posted_idx ON teacher_reviews(teacher_id, posted_at_local, id);
CREATE INDEX teacher_reviews_latest_idx ON teacher_reviews(posted_at_local DESC, id DESC, teacher_id);
CREATE INDEX teacher_reviews_author_idx ON teacher_reviews(author_id);

-- Private, reversible moderation: active tables contain only public reviews.
CREATE TABLE moderation_review_archive (
    review_type TEXT NOT NULL CHECK (review_type IN ('course', 'teacher')),
    review_id INTEGER NOT NULL CHECK (review_id > 0),
    lid TEXT REFERENCES course_section(lid),
    teacher_id INTEGER REFERENCES teachers(id),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    posted_at_local TEXT NOT NULL,
    author_id INTEGER REFERENCES auth_users(id) ON DELETE SET NULL,
    is_anonymous INTEGER NOT NULL DEFAULT 1 CHECK (is_anonymous IN (0, 1)),
    public_username TEXT,
    public_avatar_url TEXT,
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
    AND a.title = NEW.title AND a.content = NEW.content AND a.posted_at_local = NEW.posted_at_local
    AND a.is_anonymous = NEW.is_anonymous AND a.public_username IS NEW.public_username
    AND a.public_avatar_url IS NEW.public_avatar_url)
BEGIN SELECT RAISE(ABORT, 'LXK_USER_BANNED'); END;
CREATE TRIGGER teacher_reviews_ban_guard BEFORE INSERT ON teacher_reviews
WHEN (SELECT banned_at FROM auth_users WHERE id = NEW.author_id) IS NOT NULL
AND NOT EXISTS (SELECT 1 FROM moderation_review_archive a WHERE a.review_type = 'teacher'
    AND a.review_id = NEW.id AND a.teacher_id = NEW.teacher_id AND a.author_id IS NEW.author_id
    AND a.title = NEW.title AND a.content = NEW.content AND a.posted_at_local = NEW.posted_at_local
    AND a.is_anonymous = NEW.is_anonymous AND a.public_username IS NEW.public_username
    AND a.public_avatar_url IS NEW.public_avatar_url)
BEGIN SELECT RAISE(ABORT, 'LXK_USER_BANNED'); END;

CREATE TABLE category_options (
    category_type TEXT NOT NULL CHECK (category_type IN ('attr', 'college', 'lessonType', 'score')),
    position INTEGER NOT NULL CHECK (position >= 1),
    value TEXT NOT NULL,
    PRIMARY KEY (category_type, position),
    UNIQUE (category_type, value)
) WITHOUT ROWID, STRICT;

-- A single exact row replaces full-table site counts and the unfiltered catalog
-- COUNT. Updates are in the same transaction as the underlying data mutation.
CREATE TABLE site_stats (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    courses INTEGER NOT NULL CHECK (courses >= 0),
    sections INTEGER NOT NULL CHECK (sections >= 0),
    reviews INTEGER NOT NULL CHECK (reviews >= 0),
    teachers INTEGER NOT NULL CHECK (teachers >= 0)
) STRICT;

INSERT INTO site_stats (id, courses, sections, reviews, teachers)
SELECT 1,
    (SELECT COUNT(*) FROM courses),
    (SELECT COUNT(*) FROM course_section),
    (SELECT COUNT(*) FROM course_reviews) + (SELECT COUNT(*) FROM teacher_reviews),
    (SELECT COUNT(*) FROM teachers);

CREATE TRIGGER site_stats_courses_insert AFTER INSERT ON courses
BEGIN
    UPDATE site_stats SET courses = courses + 1 WHERE id = 1;
END;
CREATE TRIGGER site_stats_courses_delete AFTER DELETE ON courses
BEGIN
    UPDATE site_stats SET courses = courses - 1 WHERE id = 1;
END;
CREATE TRIGGER site_stats_sections_insert AFTER INSERT ON course_section
BEGIN
    UPDATE site_stats SET sections = sections + 1 WHERE id = 1;
END;
CREATE TRIGGER site_stats_sections_delete AFTER DELETE ON course_section
BEGIN
    UPDATE site_stats SET sections = sections - 1 WHERE id = 1;
END;
CREATE TRIGGER site_stats_teachers_insert AFTER INSERT ON teachers
BEGIN
    UPDATE site_stats SET teachers = teachers + 1 WHERE id = 1;
END;
CREATE TRIGGER site_stats_teachers_delete AFTER DELETE ON teachers
BEGIN
    UPDATE site_stats SET teachers = teachers - 1 WHERE id = 1;
END;
CREATE TRIGGER site_stats_course_reviews_insert AFTER INSERT ON course_reviews
BEGIN
    UPDATE site_stats SET reviews = reviews + 1 WHERE id = 1;
END;
CREATE TRIGGER site_stats_course_reviews_delete AFTER DELETE ON course_reviews
BEGIN
    UPDATE site_stats SET reviews = reviews - 1 WHERE id = 1;
END;
CREATE TRIGGER site_stats_teacher_reviews_insert AFTER INSERT ON teacher_reviews
BEGIN
    UPDATE site_stats SET reviews = reviews + 1 WHERE id = 1;
END;
CREATE TRIGGER site_stats_teacher_reviews_delete AFTER DELETE ON teacher_reviews
BEGIN
    UPDATE site_stats SET reviews = reviews - 1 WHERE id = 1;
END;

-- New, private proposals only. No historical catalog or review rows are replayed.
CREATE TABLE catalog_submissions (
    id TEXT PRIMARY KEY CHECK (length(id) = 36),
    author_id INTEGER NOT NULL REFERENCES auth_users(id),
    kind TEXT NOT NULL CHECK (kind IN ('course', 'teacher')),
    target_key TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
    course_id TEXT,
    college TEXT,
    elective_type TEXT,
    credits INTEGER CHECK (credits IS NULL OR credits BETWEEN 0 AND 30),
    lid TEXT,
    note TEXT NOT NULL CHECK (length(note) <= 1000),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at INTEGER NOT NULL,
    reviewed_at INTEGER,
    reviewed_by INTEGER,
    reason TEXT CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 500),
    approved_payload TEXT CHECK (approved_payload IS NULL OR json_valid(approved_payload)),
    published_course_id TEXT,
    published_lid TEXT,
    published_teacher_id INTEGER,
    operation_id TEXT UNIQUE,
    CHECK ((kind = 'teacher' AND course_id IS NULL AND college IS NULL AND elective_type IS NULL AND credits IS NULL AND lid IS NULL)
        OR (kind = 'course' AND course_id IS NOT NULL AND college IS NOT NULL AND elective_type IS NOT NULL AND credits IS NOT NULL)),
    CHECK ((status = 'pending' AND reviewed_at IS NULL AND reviewed_by IS NULL AND reason IS NULL AND operation_id IS NULL)
        OR (status <> 'pending' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND reason IS NOT NULL AND operation_id IS NOT NULL)),
    CHECK (status <> 'approved' OR (approved_payload IS NOT NULL AND
        ((kind = 'teacher' AND published_teacher_id IS NOT NULL AND published_course_id IS NULL AND published_lid IS NULL)
        OR (kind = 'course' AND published_course_id IS NOT NULL AND published_lid IS NOT NULL AND published_teacher_id IS NULL))))
) STRICT;
CREATE UNIQUE INDEX catalog_submissions_pending_target_idx ON catalog_submissions(target_key) WHERE status = 'pending';
CREATE INDEX catalog_submissions_author_created_idx ON catalog_submissions(author_id, created_at DESC, id);
CREATE INDEX catalog_submissions_status_created_idx ON catalog_submissions(status, created_at, id);

CREATE TABLE catalog_submission_events (
    operation_id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL REFERENCES catalog_submissions(id),
    actor_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('approved', 'rejected')),
    reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
    payload TEXT CHECK (payload IS NULL OR json_valid(payload)),
    created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX catalog_submission_events_submission_idx ON catalog_submission_events(submission_id, created_at);

CREATE TRIGGER catalog_submissions_original_guard BEFORE UPDATE ON catalog_submissions
WHEN NEW.id <> OLD.id OR NEW.author_id <> OLD.author_id OR NEW.kind <> OLD.kind
    OR NEW.target_key <> OLD.target_key OR NEW.name <> OLD.name OR NEW.course_id IS NOT OLD.course_id
    OR NEW.college IS NOT OLD.college OR NEW.elective_type IS NOT OLD.elective_type OR NEW.credits IS NOT OLD.credits
    OR NEW.lid IS NOT OLD.lid OR NEW.note <> OLD.note OR NEW.created_at <> OLD.created_at
BEGIN SELECT RAISE(ABORT, 'LXK_SUBMISSION_IMMUTABLE'); END;
CREATE TRIGGER catalog_submissions_decision_guard BEFORE UPDATE ON catalog_submissions
WHEN OLD.status <> 'pending' OR NEW.status = 'pending'
BEGIN SELECT RAISE(ABORT, 'LXK_SUBMISSION_ALREADY_REVIEWED'); END;
CREATE TRIGGER catalog_submission_events_update_guard BEFORE UPDATE ON catalog_submission_events
BEGIN SELECT RAISE(ABORT, 'LXK_SUBMISSION_AUDIT_IMMUTABLE'); END;
CREATE TRIGGER catalog_submission_events_delete_guard BEFORE DELETE ON catalog_submission_events
BEGIN SELECT RAISE(ABORT, 'LXK_SUBMISSION_AUDIT_IMMUTABLE'); END;
