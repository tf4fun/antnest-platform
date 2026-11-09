ALTER TABLE acp_sessions
  ADD COLUMN receipt_retained_after_append_version bigint
  CHECK (receipt_retained_after_append_version BETWEEN 0 AND 9007199254740991);

CREATE FUNCTION retain_deleted_bridge_receipt_watermark() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE acp_sessions s
     SET receipt_retained_after_append_version = GREATEST(s.receipt_retained_after_append_version, removed.append_version)
    FROM (
      SELECT session_id, MAX(COALESCE(append_version, expected_append_version, 0)) AS append_version
        FROM deleted_bridge_runs
       WHERE bridge_intent_id IS NOT NULL
       GROUP BY session_id
    ) removed
   WHERE s.id = removed.session_id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER runs_retain_bridge_receipt_watermark
  AFTER DELETE ON runs
  REFERENCING OLD TABLE AS deleted_bridge_runs
  FOR EACH STATEMENT EXECUTE FUNCTION retain_deleted_bridge_receipt_watermark();
