-- Apply as one migration transaction before deploying fractional-credit writes.
-- Incoming references to these two parents use NO ACTION, never CASCADE.
-- Keep child rows, rowids, stored counters and audit JSON exactly as they are.
PRAGMA defer_foreign_keys = ON;

-- These child-table triggers refer to course_section during ALTER validation.
DROP TRIGGER course_reviews_count_insert;
DROP TRIGGER course_reviews_count_delete;
DROP TRIGGER course_reviews_count_move;

CREATE TABLE course_section_fractional (
    lid TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(course_id),
    college TEXT NOT NULL,
    elective_type TEXT NOT NULL,
    credits REAL NOT NULL CHECK (credits >= 0),
    attribute TEXT,
    likes INTEGER NOT NULL DEFAULT 0 CHECK (likes >= 0),
    dislikes INTEGER NOT NULL DEFAULT 0 CHECK (dislikes >= 0),
    review_count INTEGER NOT NULL DEFAULT 0 CHECK (review_count >= 0)
) STRICT;
INSERT INTO course_section_fractional
    (rowid,lid,course_id,college,elective_type,credits,attribute,likes,dislikes,review_count)
SELECT rowid,lid,course_id,college,elective_type,credits,attribute,likes,dislikes,review_count FROM course_section;
DROP TABLE course_section;
ALTER TABLE course_section_fractional RENAME TO course_section;

CREATE INDEX course_section_course_id_idx ON course_section(course_id, lid);
CREATE INDEX course_section_college_idx ON course_section(college);
CREATE INDEX course_section_review_count_idx ON course_section(review_count DESC);
CREATE INDEX course_section_elective_type_idx ON course_section(elective_type, review_count DESC);
CREATE INDEX course_section_credits_idx ON course_section(credits, review_count DESC);
CREATE INDEX course_section_attribute_idx ON course_section(trim(attribute), review_count DESC);
CREATE INDEX course_section_college_credits_idx ON course_section(college, credits);

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
CREATE TRIGGER site_stats_sections_insert AFTER INSERT ON course_section
BEGIN UPDATE site_stats SET sections = sections + 1 WHERE id = 1; END;
CREATE TRIGGER site_stats_sections_delete AFTER DELETE ON course_section
BEGIN UPDATE site_stats SET sections = sections - 1 WHERE id = 1; END;

CREATE TABLE catalog_submissions_fractional (
    id TEXT PRIMARY KEY CHECK (length(id) = 36),
    author_id INTEGER NOT NULL REFERENCES auth_users(id),
    kind TEXT NOT NULL CHECK (kind IN ('course', 'teacher')),
    target_key TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
    course_id TEXT,
    college TEXT,
    elective_type TEXT,
    credits REAL CHECK (credits IS NULL OR credits BETWEEN 0 AND 30),
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
INSERT INTO catalog_submissions_fractional
    (rowid,id,author_id,kind,target_key,name,course_id,college,elective_type,credits,lid,note,status,created_at,
     reviewed_at,reviewed_by,reason,approved_payload,published_course_id,published_lid,published_teacher_id,operation_id)
SELECT rowid,id,author_id,kind,target_key,name,course_id,college,elective_type,credits,lid,note,status,created_at,
       reviewed_at,reviewed_by,reason,approved_payload,published_course_id,published_lid,published_teacher_id,operation_id
FROM catalog_submissions;
DROP TABLE catalog_submissions;
ALTER TABLE catalog_submissions_fractional RENAME TO catalog_submissions;

CREATE UNIQUE INDEX catalog_submissions_pending_target_idx ON catalog_submissions(target_key) WHERE status = 'pending';
CREATE INDEX catalog_submissions_author_created_idx ON catalog_submissions(author_id, created_at DESC, id);
CREATE INDEX catalog_submissions_status_created_idx ON catalog_submissions(status, created_at, id);
CREATE TRIGGER catalog_submissions_original_guard BEFORE UPDATE ON catalog_submissions
WHEN NEW.id <> OLD.id OR NEW.author_id <> OLD.author_id OR NEW.kind <> OLD.kind
    OR NEW.target_key <> OLD.target_key OR NEW.name <> OLD.name OR NEW.course_id IS NOT OLD.course_id
    OR NEW.college IS NOT OLD.college OR NEW.elective_type IS NOT OLD.elective_type OR NEW.credits IS NOT OLD.credits
    OR NEW.lid IS NOT OLD.lid OR NEW.note <> OLD.note OR NEW.created_at <> OLD.created_at
BEGIN SELECT RAISE(ABORT, 'LXK_SUBMISSION_IMMUTABLE'); END;
CREATE TRIGGER catalog_submissions_decision_guard BEFORE UPDATE ON catalog_submissions
WHEN OLD.status <> 'pending' OR NEW.status = 'pending'
BEGIN SELECT RAISE(ABORT, 'LXK_SUBMISSION_ALREADY_REVIEWED'); END;

PRAGMA foreign_key_check;
PRAGMA defer_foreign_keys = OFF;
-- Rebuilt indexes lost their previous planner statistics. Refresh once, bounded.
PRAGMA optimize;
