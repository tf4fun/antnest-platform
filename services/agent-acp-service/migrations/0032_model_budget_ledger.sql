-- Accounting has no Run or Agent foreign keys: purging execution records must
-- retain known spend and unresolved reservations. Atomic business writes lock
-- organization -> Agent lease -> Run. Liveness, shutdown and destruction are
-- never evidence of zero usage.
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
    PRIMARY KEY (run_id, ordinal),
    CHECK (month_start = date_trunc('month', day_start)::date)
);

CREATE INDEX model_budget_reservations_org_day_idx
    ON model_budget_reservations (organization_id, day_start);
CREATE INDEX model_budget_reservations_org_month_idx
    ON model_budget_reservations (organization_id, month_start);

COMMENT ON TABLE model_budget_reservations IS
    'No Run or Agent foreign keys: known charges and unresolved reservations remain after purge. Organization -> lease -> Run transactions own atomic writes; shutdown, liveness and destruction never settle unknown usage as zero.';
