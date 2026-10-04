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

CREATE TABLE course_section_teachers (
    lid TEXT NOT NULL REFERENCES course_section(lid),
    teacher_id INTEGER NOT NULL REFERENCES teachers(id),
    position INTEGER NOT NULL CHECK (position >= 1),
    PRIMARY KEY (lid, teacher_id),
    UNIQUE (lid, position)
) WITHOUT ROWID, STRICT;

CREATE INDEX course_section_teachers_teacher_idx ON course_section_teachers(teacher_id, lid);

CREATE TABLE course_reviews (
    id INTEGER PRIMARY KEY,
    lid TEXT NOT NULL REFERENCES course_section(lid),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    posted_at_local TEXT NOT NULL
) STRICT;

CREATE INDEX course_reviews_lid_idx ON course_reviews(lid);
CREATE INDEX course_reviews_latest_idx ON course_reviews(posted_at_local DESC, id DESC, lid);

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
    id INTEGER PRIMARY KEY,
    teacher_id INTEGER NOT NULL REFERENCES teachers(id),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    posted_at_local TEXT NOT NULL
) STRICT;

CREATE INDEX teacher_reviews_teacher_posted_idx ON teacher_reviews(teacher_id, posted_at_local, id);
CREATE INDEX teacher_reviews_latest_idx ON teacher_reviews(posted_at_local DESC, id DESC, teacher_id);

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
