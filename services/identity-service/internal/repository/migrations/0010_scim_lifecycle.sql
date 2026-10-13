-- Legacy expiry is anchored to issuance, never deployment. Calendar-year
-- backfill is intentional; new credentials use a bounded number of 24h days.
ALTER TABLE scim_tokens
    ADD COLUMN expires_at TIMESTAMPTZ,
    ADD COLUMN issued_by TEXT REFERENCES users(id),
    ADD COLUMN issuer_review_required BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE scim_tokens
SET expires_at = (created_at AT TIME ZONE 'UTC' + INTERVAL '1 year') AT TIME ZONE 'UTC',
    issuer_review_required = TRUE;

-- Count distinct audited actors before checking User existence. An existing
-- actor plus a deleted/unknown actor is ambiguous, not evidence for the survivor.
WITH audited_issuers AS (
    SELECT t.id, MIN(e.actor_principal_id) AS user_id
    FROM scim_tokens t
    JOIN identity_events e ON e.organization_id = t.organization_id
        AND e.subject_id = t.id AND e.subject_type = 'scim_token'
        AND e.event_type = 'scim_token.issued'
    GROUP BY t.id
    HAVING COUNT(DISTINCT e.actor_principal_id) = 1
)
UPDATE scim_tokens t
SET issued_by = a.user_id, issuer_review_required = FALSE
FROM audited_issuers a JOIN users u ON u.id = a.user_id
WHERE t.id = a.id;

ALTER TABLE scim_tokens
    ALTER COLUMN expires_at SET NOT NULL,
    ALTER COLUMN expires_at SET DEFAULT (now() + INTERVAL '2160 hours'),
    ADD CONSTRAINT scim_tokens_finite_lifetime CHECK (
        isfinite(expires_at) AND expires_at > created_at
    ),
    ADD CONSTRAINT scim_tokens_issuer_review CHECK (
        issued_by IS NOT NULL OR issuer_review_required
    );

CREATE INDEX scim_tokens_unrevoked_issuer_idx
    ON scim_tokens (issued_by, organization_id, id)
    WHERE revoked_at IS NULL AND issued_by IS NOT NULL;
