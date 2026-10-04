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
