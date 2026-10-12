CREATE TABLE credential_attempts (
    scope TEXT NOT NULL CHECK (scope IN ('organization', 'login_account', 'password_change_user')),
    key_hash BYTEA NOT NULL CHECK (octet_length(key_hash) = 32),
    window_start TIMESTAMPTZ NOT NULL,
    failures INTEGER NOT NULL CHECK (
        failures >= 0 AND failures <= CASE WHEN scope = 'organization' THEN 110 ELSE 15 END
    ),
    locked_until TIMESTAMPTZ,
    PRIMARY KEY (scope, key_hash)
);

CREATE INDEX credential_attempts_cleanup ON credential_attempts (window_start, scope, key_hash);
