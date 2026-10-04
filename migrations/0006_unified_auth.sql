-- Additive and compatible with the previous public application. No historical
-- review is attributed to an identity inferred from its content.
CREATE TABLE auth_users (
    id INTEGER PRIMARY KEY,
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER NOT NULL,
    UNIQUE (issuer, subject)
) STRICT;

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

ALTER TABLE course_reviews ADD COLUMN author_id INTEGER REFERENCES auth_users(id) ON DELETE SET NULL;
ALTER TABLE teacher_reviews ADD COLUMN author_id INTEGER REFERENCES auth_users(id) ON DELETE SET NULL;
CREATE INDEX course_reviews_author_idx ON course_reviews(author_id);
CREATE INDEX teacher_reviews_author_idx ON teacher_reviews(author_id);
