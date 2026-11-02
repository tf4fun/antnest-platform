import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const contractPath = "contracts/agent-acp/data-retention.json";
const documentPath = "contracts/agent-acp/data-retention.md";
const contract = () =>
  JSON.parse(readFileSync(new URL(contractPath, root), "utf8"));
const document = () => readFileSync(new URL(documentPath, root), "utf8");
const sorted = (values) => [...values].sort();
const budgetTables = [
  "model_budget_baseline_attempts",
  "model_budget_baseline_receipts",
  "model_budget_history",
  "model_budget_reservations",
  "organization_spend",
  "run_usage",
];
const blockedWork = [
  "nonterminal, unresolved or non-quiescent Runs",
  "running Learning tasks",
  "unreleased temporary Skills",
  "unsettled maintenance or protection",
];
const operatorLifecycle = [
  "backups",
  "WAL",
  "logs",
  "published Skill distribution",
  "replicas",
];

test("data retention is an agent-acp-service contract with status-consistent activation", () => {
  const value = contract();
  assert.equal(value.contract, "antnest.agent-acp.data-retention");
  assert.equal(value.version, 1);
  assert.equal(value.issue, 55);
  assert.equal(value.owner_service, "agent-acp-service");
  assert.equal(value.semantics, "data-retention.md");
  assert.ok(existsSync(new URL(documentPath, root)), "semantics document");
  assert.ok(["planned", "active"].includes(value.status));
  if (value.status === "planned") {
    assert.match(value.activation, /contract only/iu);
    assert.match(value.activation, /not|no |without/iu);
  } else {
    assert.doesNotMatch(value.activation, /contract only/iu);
    assert.match(value.activation, /activat/iu);
  }
});

test("configuration freezes environment names, defaults and bounds", () => {
  const value = contract();
  assert.deepEqual(value.config, {
    deleted_session_retention: {
      environment: "ANTNEST_ACP_DELETED_SESSION_RETENTION",
      default: "30d",
      disabled: "0",
    },
    purge_batch: {
      environment: "ANTNEST_ACP_PURGE_BATCH",
      default: 500,
      minimum: 1,
      maximum: 500,
    },
    purge_interval: {
      environment: "ANTNEST_ACP_PURGE_INTERVAL",
      default: "60s",
    },
  });
  assert.ok(
    value.config.purge_batch.minimum <= value.config.purge_batch.default &&
      value.config.purge_batch.default <= value.config.purge_batch.maximum,
  );
});

test("retention is measured by durable deleted_at under a strict cutoff", () => {
  const retention = contract().retention;
  assert.match(retention.applies_to, /deleted/iu);
  assert.equal(retention.measured_by, "durable deleted_at");
  assert.match(retention.pre_existing_deleted_rows, /backfill/iu);
  assert.match(retention.pre_existing_deleted_rows, /migration/iu);
  assert.match(retention.pre_existing_deleted_rows, /conservative/iu);
  assert.equal(retention.eligibility, "strict deleted_at < cutoff");
});

test("automated purge removes only deleted Sessions and preserves receipt semantics", () => {
  const scope = contract().purge_scope;
  assert.match(scope.automated_removes, /deleted Sessions/);
  assert.match(scope.automated_removes, /derived learning records/iu);
  for (const retained of [
    "active Sessions",
    "closed Sessions that are not deleted",
    "Run history of Sessions that are not deleted",
  ])
    assert.ok(scope.automated_never_removes.includes(retained), retained);
  assert.equal(scope.retained_session_receipts, "unchanged");
  assert.equal(
    scope.purged_session_lookup,
    "session_not_found after ordinary authorization",
  );
  assert.deepEqual(sorted(scope.not_activated), [
    "expired receipt outcomes",
    "issue 19 active-history compaction",
  ]);
});

test("the purge worker is bounded, transactional and fenced at commit", () => {
  const worker = contract().worker;
  assert.equal(worker.batch_maximum, "config.purge_batch Sessions per batch");
  assert.equal(worker.transactional, true);
  assert.equal(worker.rollback_safe, true);
  assert.match(worker.ownership, /legacy worker/iu);
  assert.match(worker.ownership, /per-Agent generation fence/iu);
  assert.match(worker.ownership, /peer mode/iu);
  assert.equal(worker.commit_check, "live fence check at commit");
  assert.deepEqual(sorted(worker.never_purges), sorted(blockedWork));
  assert.match(worker.blocked_disposition, /skipped/iu);
  assert.match(worker.blocked_disposition, /never/iu);
  assert.match(worker.blocked_disposition, /not|never.*success/iu);
  assert.match(worker.scan_progress, /starvation/iu);
});

test("the operator CLI is offline, exclusive and takes exactly one selector", () => {
  const cli = contract().cli;
  assert.equal(cli.command, "node dist/purge.js");
  assert.deepEqual(sorted(cli.selectors), [
    "--organization",
    "--session",
    "--user",
  ]);
  assert.equal(cli.selector_cardinality, "exactly one");
  assert.equal(cli.mode, "offline maintenance");
  assert.equal(cli.lock, "the exclusive existing ACP worker lock");
  assert.match(cli.live_acp, /refus/iu);
  assert.match(cli.live_acp, /peer|shared/iu);
  assert.equal(cli.side_effects.starts_service_or_listeners, false);
  assert.equal(cli.side_effects.runs_migrations, false);
});

test("CLI selectors scope Session content only and gate deletion on confirmation", () => {
  const cli = contract().cli;
  assert.equal(
    cli.selector_semantics["--organization"],
    "all Session principals of the organization",
  );
  assert.equal(
    cli.selector_semantics["--user"],
    "one principal across ACP organizations",
  );
  assert.equal(cli.selector_semantics["--session"], "one Session");
  assert.match(cli.scope_limit, /Session content/);
  assert.match(cli.scope_limit, /derived learning records/iu);
  assert.match(cli.scope_limit, /never/iu);
  for (const external of ["Identity", "Controller", "Runtime", "Registry"])
    assert.match(cli.scope_limit, new RegExp(external, "u"));
  assert.equal(
    cli.retention_override,
    "explicit confirmed erasure includes active, closed and deleted Sessions without grace-period delay; quiescence and cleanup guards still apply",
  );
  assert.match(cli.dry_run, /lock/iu);
  assert.match(cli.dry_run, /bounded-batch counts/iu);
  assert.match(cli.dry_run, /only/iu);
  assert.match(cli.confirm, /required/iu);
  assert.match(cli.confirm, /dry-run|--dry-run/iu);
  assert.equal(cli.exit.hard_failure, "nonzero");
  assert.match(cli.exit.blocked_counts, /reported/iu);
  assert.match(cli.exit.blocked_counts, /nonzero/iu);
  assert.equal(cli.exit.rerun, "resumes remaining work");
});

test("each committed batch emits a count-only purge audit event", () => {
  const audit = contract().audit;
  assert.equal(audit.event, "acp_content_purge_batch");
  assert.match(audit.emitted, /committed batch/iu);
  assert.equal(audit.payload, "counts only");
  for (const excluded of [
    "content",
    "Session IDs",
    "Run IDs",
    "user IDs",
    "organization IDs",
    "SQL",
  ])
    assert.ok(audit.excludes.includes(excluded), excluded);
});

test("published Skill artifacts survive source purge with tombstoned provenance", () => {
  const skill = contract().published_skill;
  assert.match(skill.artifact, /readable/iu);
  assert.match(skill.artifact, /re-publishable/iu);
  assert.equal(skill.provenance, "explicitly tombstoned");
  assert.deepEqual(sorted(skill.removed), [
    "evidence bodies",
    "request bodies",
    "unpublished candidates",
  ]);
});

test("retained budget and accounting records are never reduced by purge", () => {
  const retained = contract().retained_records;
  assert.match(retained.budget_accounting, /never/iu);
  assert.match(retained.budget_accounting, /reduc|zero/iu);
  assert.match(retained.budget_accounting, /unknown charges/iu);
  assert.deepEqual(sorted(retained.budget_tables), sorted(budgetTables));
  assert.equal(retained.published_artifact_table, "learning_managed_skills");
  assert.match(retained.documentation, /table documentation/iu);
  assert.match(retained.documentation, /exception/iu);
});

test("lifecycle boundaries are explicit without a GDPR erasure claim", () => {
  const boundaries = contract().boundaries;
  assert.deepEqual(
    sorted(boundaries.separate_operator_lifecycle),
    sorted(operatorLifecycle),
  );
  assert.equal(boundaries.comprehensive_gdpr_erasure_claimed, false);
});

test("the semantics document records the command, exceptions and boundaries", () => {
  const text = document();
  for (const name of [
    "ANTNEST_ACP_DELETED_SESSION_RETENTION",
    "ANTNEST_ACP_PURGE_BATCH",
    "ANTNEST_ACP_PURGE_INTERVAL",
  ])
    assert.ok(text.includes(name), name);
  for (const flag of [
    "--organization",
    "--user",
    "--session",
    "--dry-run",
    "--confirm",
  ])
    assert.ok(text.includes(flag), flag);
  assert.match(text, /node dist\/purge\.js/u);
  assert.match(text, /deleted_at/iu);
  assert.match(text, /session_not_found/iu);
  assert.match(text, /acp_content_purge_batch/iu);
  assert.match(text, /tombston/iu);
  for (const table of [...budgetTables, "learning_managed_skills"])
    assert.ok(text.includes(table), table);
  assert.match(text, /backups?/iu);
  assert.match(text, /WAL|write-ahead/iu);
  assert.match(text, /replicas?/iu);
  assert.match(text, /GDPR/iu);
  assert.match(text, /worker lock|worker-lock/iu);
  assert.match(text, /generation fence|fencing/iu);
});
