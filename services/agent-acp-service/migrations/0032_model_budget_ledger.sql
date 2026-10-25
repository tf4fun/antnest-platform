-- Accounting has no Run or Agent foreign keys: purging execution records must
-- retain known spend and unresolved reservations. Atomic business writes lock
-- organization -> Agent lease -> Run. Liveness, shutdown and destruction are
-- never evidence of zero usage.
-- Retire all old workers AND pending startups before this upgrade, as with
-- participation migration 0031. A paused old startup is not fenced by this lock.
DO $$ BEGIN
    IF NOT pg_try_advisory_xact_lock(2026083002) THEN
        RAISE EXCEPTION 'Retire all ACP workers before enabling the model budget ledger';
    END IF;
END $$;

-- A migrated database may already have purged its entire execution history.
-- Record the coverage boundary independently of any surviving organization,
-- Run or Session. An empty table does not prove zero historical consumption.
CREATE TABLE model_budget_history (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    cutover_at timestamptz NOT NULL,
    complete_before_cutover boolean NOT NULL
);
INSERT INTO model_budget_history(singleton,cutover_at,complete_before_cutover)
VALUES(true,clock_timestamp(),coalesce(current_setting('antnest.fresh_database_install',true)='true',false));

CREATE TABLE run_usage (
    run_id text PRIMARY KEY,
    organization_id text NOT NULL,
    agent_id text NOT NULL,
    input_tokens numeric NOT NULL DEFAULT 0 CHECK (input_tokens >= 0 AND input_tokens = trunc(input_tokens)),
    output_tokens numeric NOT NULL DEFAULT 0 CHECK (output_tokens >= 0 AND output_tokens = trunc(output_tokens)),
    cost_usd_micros numeric NOT NULL DEFAULT 0 CHECK (cost_usd_micros >= 0 AND cost_usd_micros = trunc(cost_usd_micros)),
    reserved_input_tokens numeric NOT NULL DEFAULT 0 CHECK (reserved_input_tokens >= 0 AND reserved_input_tokens = trunc(reserved_input_tokens)),
    reserved_output_tokens numeric NOT NULL DEFAULT 0 CHECK (reserved_output_tokens >= 0 AND reserved_output_tokens = trunc(reserved_output_tokens)),
    reserved_cost_usd_micros numeric NOT NULL DEFAULT 0 CHECK (reserved_cost_usd_micros >= 0 AND reserved_cost_usd_micros = trunc(reserved_cost_usd_micros)),
    unknown_input_attempts numeric NOT NULL DEFAULT 0 CHECK (unknown_input_attempts >= 0 AND unknown_input_attempts = trunc(unknown_input_attempts)),
    unknown_output_attempts numeric NOT NULL DEFAULT 0 CHECK (unknown_output_attempts >= 0 AND unknown_output_attempts = trunc(unknown_output_attempts)),
    unbounded_cost_attempts numeric NOT NULL DEFAULT 0 CHECK (unbounded_cost_attempts >= 0 AND unbounded_cost_attempts = trunc(unbounded_cost_attempts)),
    unknown_attempts numeric NOT NULL DEFAULT 0 CHECK (unknown_attempts >= 0 AND unknown_attempts = trunc(unknown_attempts))
);

COMMENT ON TABLE run_usage IS
    'Accounting survives Run purge without foreign keys; organization -> lease -> Run transactions preserve charges and reservations. Liveness or destruction does not prove zero usage.';

CREATE TABLE organization_spend (
    organization_id text NOT NULL,
    period text NOT NULL CHECK (period IN ('daily', 'monthly')),
    period_start date NOT NULL,
    cost_usd_micros numeric NOT NULL DEFAULT 0 CHECK (cost_usd_micros >= 0 AND cost_usd_micros = trunc(cost_usd_micros)),
    reserved_cost_usd_micros numeric NOT NULL DEFAULT 0 CHECK (reserved_cost_usd_micros >= 0 AND reserved_cost_usd_micros = trunc(reserved_cost_usd_micros)),
    unbounded_cost_attempts numeric NOT NULL DEFAULT 0 CHECK (unbounded_cost_attempts >= 0 AND unbounded_cost_attempts = trunc(unbounded_cost_attempts)),
    unknown_attempts numeric NOT NULL DEFAULT 0 CHECK (unknown_attempts >= 0 AND unknown_attempts = trunc(unknown_attempts)),
    PRIMARY KEY (organization_id, period, period_start),
    CHECK (period <> 'monthly' OR EXTRACT(DAY FROM period_start) = 1)
);

COMMENT ON TABLE organization_spend IS
    'Organization charges and unresolved reservations survive Run or Agent purge; atomic updates use organization -> lease -> Run transactions and never infer zero usage from process or resource loss.';

CREATE TABLE model_budget_reservations (
    run_id text NOT NULL,
    ordinal bigint NOT NULL CHECK (ordinal BETWEEN 1 AND 9007199254740991),
    organization_id text NOT NULL,
    agent_id text NOT NULL,
    policy_revision bigint NOT NULL CHECK (policy_revision BETWEEN 0 AND 9007199254740991),
    input_tokens numeric CHECK (input_tokens >= 0 AND input_tokens = trunc(input_tokens)),
    output_tokens numeric CHECK (output_tokens >= 0 AND output_tokens = trunc(output_tokens)),
    cost_usd_micros numeric CHECK (cost_usd_micros >= 0 AND cost_usd_micros = trunc(cost_usd_micros)),
    state text NOT NULL CHECK (state IN ('reserved', 'unresolved', 'settled')),
    cost_unknown boolean NOT NULL,
    day_start date NOT NULL,
    month_start date NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    settled_at timestamptz NULL,
    settlement jsonb CHECK (settlement IS NULL OR jsonb_typeof(settlement) = 'object'),
    PRIMARY KEY (run_id, ordinal),
    CHECK (month_start = date_trunc('month', day_start)::date)
);

CREATE INDEX model_budget_reservations_org_day_idx
    ON model_budget_reservations (organization_id, day_start);
CREATE INDEX model_budget_reservations_org_month_idx
    ON model_budget_reservations (organization_id, month_start);

COMMENT ON TABLE model_budget_reservations IS
    'No Run or Agent foreign keys: known charges and unresolved reservations remain after purge. Organization -> lease -> Run transactions own atomic writes; shutdown, liveness and destruction never settle unknown usage as zero.';

-- Preserve the original accounting source independently of execution purge.
-- Retain both receipt time and a verified hidden attempt's original start time.
-- Older receipts without that identity link retain their receipt-time basis.
CREATE TABLE model_budget_baseline_receipts (
    receipt_id text PRIMARY KEY,
    run_id text,
    organization_id text NOT NULL,
    agent_id text NOT NULL,
    receipt_at timestamptz NOT NULL,
    attempt_started_at timestamptz,
    input_tokens numeric CHECK (input_tokens >= 0 AND input_tokens = trunc(input_tokens)),
    output_tokens numeric CHECK (output_tokens >= 0 AND output_tokens = trunc(output_tokens)),
    cost_usd_micros numeric CHECK (cost_usd_micros >= 0 AND cost_usd_micros = trunc(cost_usd_micros))
);

-- Schema 0031 never reserved budget. An unmatched start therefore has unknown
-- input, output and cost, even when its Run is terminal or has been purged.
CREATE TABLE model_budget_baseline_attempts (
    start_id text PRIMARY KEY,
    run_id text,
    organization_id text NOT NULL,
    agent_id text NOT NULL,
    ordinal bigint NOT NULL CHECK (ordinal BETWEEN 1 AND 9007199254740991),
    started_at timestamptz NOT NULL
);

-- Migration-local helpers use PostgreSQL decimal arithmetic. They are removed
-- before committing the migration and never convert accounting through float.
CREATE FUNCTION antnest_budget_import_number(value jsonb, maximum numeric)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE parsed numeric;
BEGIN
    IF jsonb_typeof(value) <> 'number' THEN RETURN NULL; END IF;
    parsed := (value #>> '{}')::numeric;
    IF parsed < 0 OR parsed > maximum THEN RETURN NULL; END IF;
    RETURN parsed;
END $$;

CREATE FUNCTION antnest_budget_import_tokens(value jsonb)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE parsed numeric;
BEGIN
    parsed := antnest_budget_import_number(value, 9007199254740991);
    IF parsed IS NULL OR parsed <> trunc(parsed) THEN RETURN NULL; END IF;
    RETURN parsed;
END $$;

CREATE FUNCTION antnest_budget_import_cost(measurement jsonb)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
    receipt jsonb := measurement->'cost';
    pricing jsonb := receipt->'pricing';
    amount numeric;
    input_count numeric;
    output_count numeric;
    read_count numeric;
    write_count numeric;
    input_rate numeric;
    output_rate numeric;
    read_rate numeric;
    write_rate numeric;
BEGIN
    IF receipt->>'currency' IS DISTINCT FROM 'USD' THEN RETURN NULL; END IF;
    amount := antnest_budget_import_number(receipt->'amount', 9007199254740991);
    IF amount IS NULL THEN RETURN NULL; END IF;
    IF receipt->>'source' = 'provider_reported' THEN RETURN ceil(amount * 1000000); END IF;
    IF receipt->>'source' IS DISTINCT FROM 'estimated'
       OR pricing->>'currency' IS DISTINCT FROM 'USD' THEN RETURN NULL; END IF;
    input_count := antnest_budget_import_tokens(measurement->'inputTokens');
    output_count := antnest_budget_import_tokens(measurement->'outputTokens');
    read_count := CASE WHEN measurement ? 'cacheReadTokens'
        THEN antnest_budget_import_tokens(measurement->'cacheReadTokens') ELSE 0 END;
    write_count := CASE WHEN measurement ? 'cacheWriteTokens'
        THEN antnest_budget_import_tokens(measurement->'cacheWriteTokens') ELSE 0 END;
    input_rate := antnest_budget_import_number(pricing->'inputPerMillion', 1.7976931348623157e308);
    output_rate := antnest_budget_import_number(pricing->'outputPerMillion', 1.7976931348623157e308);
    read_rate := CASE WHEN pricing ? 'cacheReadPerMillion'
        THEN antnest_budget_import_number(pricing->'cacheReadPerMillion', 1.7976931348623157e308) ELSE input_rate END;
    write_rate := CASE WHEN pricing ? 'cacheWritePerMillion'
        THEN antnest_budget_import_number(pricing->'cacheWritePerMillion', 1.7976931348623157e308) ELSE input_rate END;
    IF input_count IS NULL OR output_count IS NULL OR read_count IS NULL OR write_count IS NULL
       OR input_rate IS NULL OR output_rate IS NULL OR read_rate IS NULL OR write_rate IS NULL
       OR read_count + write_count > input_count THEN RETURN NULL; END IF;
    RETURN ceil((input_count-read_count-write_count)*input_rate + output_count*output_rate
                + read_count*read_rate + write_count*write_rate);
END $$;

CREATE FUNCTION antnest_budget_import_id(resource_namespace text, resource_key text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT 'message_' || substr(encode(sha256(
        convert_to(resource_namespace,'UTF8') || decode('00','hex') ||
        convert_to(resource_key,'UTF8')
    ),'hex'),1,32)
$$;

WITH attempt_starts AS (
    SELECT started.run_id, started.session_id, started.created_at,
           ordinal.value AS ordinal,
           'message_' || substr(encode(sha256(
               convert_to('model-attempt', 'UTF8') || decode('00', 'hex') ||
               convert_to(started.run_id || ':' || trunc(ordinal.value)::text || ':finish', 'UTF8')
           ), 'hex'), 1, 32) AS finish_id,
           'message_' || substr(encode(sha256(
               convert_to('model-attempt-usage', 'UTF8') || decode('00', 'hex') ||
               convert_to(started.run_id || ':' || trunc(ordinal.value)::text, 'UTF8')
           ), 'hex'), 1, 32) AS receipt_id
    FROM session_messages started
    CROSS JOIN LATERAL (
        SELECT antnest_budget_import_tokens(started.payload->'ordinal') AS value
    ) ordinal
    WHERE started.kind='model_attempt' AND NOT started.visible AND started.context_excluded
      AND started.payload->>'kind'='model_attempt' AND started.payload->>'phase'='start'
      AND ordinal.value >= 1
      AND started.id = 'message_' || substr(encode(sha256(
          convert_to('model-attempt', 'UTF8') || decode('00', 'hex') ||
          convert_to(started.run_id || ':' || trunc(ordinal.value)::text || ':start', 'UTF8')
      ), 'hex'), 1, 32)
)
INSERT INTO model_budget_baseline_receipts(
    receipt_id, run_id, organization_id, agent_id, receipt_at, attempt_started_at,
    input_tokens, output_tokens, cost_usd_micros
)
SELECT m.id, m.run_id, s.organization_id, s.agent_id, m.created_at, started.created_at,
       antnest_budget_import_tokens(m.payload->'measurement'->'inputTokens'),
       antnest_budget_import_tokens(m.payload->'measurement'->'outputTokens'),
       CASE WHEN finished.id IS NOT NULL THEN 0
            ELSE antnest_budget_import_cost(m.payload->'measurement') END
FROM session_messages m JOIN acp_sessions s ON s.id=m.session_id
LEFT JOIN attempt_starts started ON started.run_id=m.run_id
    AND started.session_id=m.session_id AND started.receipt_id=m.id
    AND started.created_at <= m.created_at
-- Internal zero cost needs the complete original canonical receipt pair. A
-- purged Run (NULL association), copied/missing finish, or contradictory usage
-- never gains this proof. No Provider-reported cost is manufactured.
LEFT JOIN session_messages finished ON finished.id=started.finish_id
    AND finished.run_id=m.run_id AND finished.session_id=m.session_id
    AND finished.kind='model_attempt' AND NOT finished.visible AND finished.context_excluded
    AND finished.created_at=m.created_at
    AND finished.payload->>'kind'='model_attempt' AND finished.payload->>'phase'='finish'
    AND finished.payload->'ordinal'=to_jsonb(started.ordinal)
    AND finished.payload->'notDispatched'='true'::jsonb
    AND finished.payload->>'outcome' IN ('failed','cancelled')
    AND finished.payload->'outputStarted'='false'::jsonb
    AND NOT (finished.payload ? 'status')
    AND finished.payload->'usage'=m.payload->'measurement'
    AND m.payload->'measurement'='{"inputTokens":0,"outputTokens":0}'::jsonb
WHERE m.kind='usage'
  -- Fork copies retain the original usage and clear run_id. Their deterministic
  -- copy ID distinguishes them from a real receipt whose Run was later purged.
  AND m.id <> 'message_' || substr(encode(sha256(
      convert_to('fork-message', 'UTF8') || decode('00', 'hex') ||
      convert_to(m.session_id || ':' || m.sequence::text, 'UTF8')
  ), 'hex'), 1, 32);

INSERT INTO model_budget_baseline_attempts(
    start_id,run_id,organization_id,agent_id,ordinal,started_at
)
SELECT started.id,started.run_id,s.organization_id,s.agent_id,ordinal.value::bigint,started.created_at
FROM session_messages started JOIN acp_sessions s ON s.id=started.session_id
CROSS JOIN LATERAL (
    SELECT antnest_budget_import_tokens(started.payload->'ordinal') AS value
) ordinal
WHERE started.kind='model_attempt' AND NOT started.visible AND started.context_excluded
  AND started.payload->>'kind'='model_attempt' AND started.payload->>'phase'='start'
  AND ordinal.value >= 1
  AND (started.run_id IS NULL OR started.id=antnest_budget_import_id(
      'model-attempt',started.run_id || ':' || trunc(ordinal.value)::text || ':start'))
  AND NOT EXISTS (
      SELECT 1 FROM session_messages finished
      JOIN session_messages receipt ON receipt.id=antnest_budget_import_id(
          'model-attempt-usage',started.run_id || ':' || trunc(ordinal.value)::text)
      WHERE finished.id=antnest_budget_import_id(
          'model-attempt',started.run_id || ':' || trunc(ordinal.value)::text || ':finish')
        AND finished.run_id=started.run_id AND finished.session_id=started.session_id
        AND finished.kind='model_attempt' AND NOT finished.visible AND finished.context_excluded
        AND finished.payload->>'kind'='model_attempt' AND finished.payload->>'phase'='finish'
        AND finished.payload->'ordinal'=started.payload->'ordinal'
        AND receipt.run_id=started.run_id AND receipt.session_id=started.session_id
        AND receipt.kind='usage' AND receipt.visible
        AND finished.payload->'usage'=receipt.payload->'measurement'
        AND finished.created_at >= started.created_at AND receipt.created_at=finished.created_at
  );

INSERT INTO run_usage(
    run_id, organization_id, agent_id, input_tokens, output_tokens, cost_usd_micros,
    unknown_input_attempts, unknown_output_attempts, unknown_attempts, unbounded_cost_attempts
)
SELECT run_id, organization_id, agent_id,
       sum(coalesce(input_tokens,0)), sum(coalesce(output_tokens,0)), sum(coalesce(cost_usd_micros,0)),
       count(*) FILTER (WHERE input_tokens IS NULL), count(*) FILTER (WHERE output_tokens IS NULL),
       count(*) FILTER (WHERE cost_usd_micros IS NULL), count(*) FILTER (WHERE cost_usd_micros IS NULL)
FROM (
    SELECT run_id,organization_id,agent_id,input_tokens,output_tokens,cost_usd_micros
    FROM model_budget_baseline_receipts
    UNION ALL
    SELECT run_id,organization_id,agent_id,NULL::numeric,NULL::numeric,NULL::numeric
    FROM model_budget_baseline_attempts
) source WHERE run_id IS NOT NULL
GROUP BY run_id, organization_id, agent_id;

INSERT INTO organization_spend(
    organization_id, period, period_start, cost_usd_micros, unknown_attempts, unbounded_cost_attempts
)
SELECT source.organization_id, bucket.period, bucket.period_start,
       sum(coalesce(source.cost_usd_micros,0)),
       count(*) FILTER (WHERE source.cost_usd_micros IS NULL),
       count(*) FILTER (WHERE source.cost_usd_micros IS NULL)
FROM (
    SELECT organization_id,cost_usd_micros,coalesce(attempt_started_at,receipt_at) AS accounted_at
    FROM model_budget_baseline_receipts
    UNION ALL
    SELECT organization_id,NULL::numeric,started_at FROM model_budget_baseline_attempts
) source
CROSS JOIN LATERAL (VALUES
    ('daily', (source.accounted_at AT TIME ZONE 'UTC')::date),
    ('monthly', date_trunc('month', source.accounted_at AT TIME ZONE 'UTC')::date)
) AS bucket(period,period_start)
GROUP BY source.organization_id, bucket.period, bucket.period_start;

DROP FUNCTION antnest_budget_import_cost(jsonb);
DROP FUNCTION antnest_budget_import_id(text,text);
DROP FUNCTION antnest_budget_import_tokens(jsonb);
DROP FUNCTION antnest_budget_import_number(jsonb,numeric);


-- Admission rejection and accepted execution share the original budget fact.
-- NULL keeps pre-budget terminal records and non-budget outcomes unchanged.
ALTER TABLE runs ADD COLUMN budget_reason jsonb;
ALTER TABLE runs ADD CONSTRAINT runs_budget_reason_check CHECK (
    budget_reason IS NULL OR (
        jsonb_typeof(budget_reason) = 'object'
        AND error_class IS NOT DISTINCT FROM 'budget_exceeded'
        AND state IN ('failed', 'unresolved')
    )
);
