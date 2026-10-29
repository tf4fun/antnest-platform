CREATE VIEW model_token_calibration AS
WITH measured AS (
    SELECT r.organization_id,
           started.payload->>'modelProfileId' AS model_profile_id,
           started.payload->>'model' AS model,
           COALESCE(started.payload->>'tokenizer', 'none') AS tokenizer,
           finished.created_at,
           finished.id,
           CASE WHEN jsonb_typeof(started.payload->'estimatedInputTokens') = 'number'
                     AND jsonb_typeof(finished.payload->'usage'->'inputTokens') = 'number'
                     AND started.payload->>'estimatedInputTokens' ~ '^[0-9]+$'
                     AND finished.payload->'usage'->>'inputTokens' ~ '^[0-9]+$'
                THEN (finished.payload->'usage'->>'inputTokens')::double precision /
                     NULLIF((started.payload->>'estimatedInputTokens')::double precision, 0)
           END AS ratio
    FROM session_messages started
    JOIN runs r ON r.id = started.run_id
    JOIN session_messages finished
      ON finished.run_id = started.run_id
     AND finished.kind = 'model_attempt'
     AND finished.payload->>'phase' = 'finish'
     AND finished.payload->>'ordinal' = started.payload->>'ordinal'
     AND finished.payload->>'outcome' = 'completed'
    WHERE started.kind = 'model_attempt'
      AND started.payload->>'phase' = 'start'
), ranked AS (
    SELECT *, row_number() OVER (
        PARTITION BY organization_id, model_profile_id, model, tokenizer
        ORDER BY created_at DESC, id DESC
    ) AS sample_rank
    FROM measured
    WHERE ratio IS NOT NULL
)
SELECT organization_id, model_profile_id, model, tokenizer,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY ratio) AS ratio_p95,
       count(*) AS samples
FROM ranked
WHERE sample_rank <= 128
GROUP BY organization_id, model_profile_id, model, tokenizer;
