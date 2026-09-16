-- Model context eligibility is separate from the retained ACP transcript.
ALTER TABLE session_messages
    ADD COLUMN context_excluded boolean NOT NULL DEFAULT false;

-- Existing forks deliberately have no Run FK. Follow only inherited messages
-- at the same sequence; a fork's own later turns must not inherit a parent's
-- subsequent refusal just because their sequence numbers happen to match.
WITH RECURSIVE refused AS (
    SELECT m.id, m.session_id, m.sequence
      FROM session_messages m JOIN runs r ON r.id = m.run_id
     WHERE r.stop_reason = 'refusal'
    UNION
    SELECT m.id, m.session_id, m.sequence
      FROM refused parent
      JOIN acp_sessions child ON child.forked_from_session_id = parent.session_id
      JOIN session_messages m ON m.session_id = child.id AND m.sequence = parent.sequence
     WHERE m.run_id IS NULL
)
UPDATE session_messages SET context_excluded = true
 WHERE id IN (SELECT id FROM refused);

-- Old summaries may already contain a refused turn. Rebuild them from the
-- retained eligible messages on demand; keep earlier uncontaminated summaries.
DELETE FROM context_checkpoints c
 WHERE EXISTS (
    SELECT 1 FROM session_messages m
     WHERE m.session_id = c.session_id AND m.context_excluded
       AND m.sequence <= c.through_sequence
 );
