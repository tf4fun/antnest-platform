const phases = [
  "sessions",
  "create",
  "readyContext",
  "ready",
  "initialize",
  "session",
  "prompt",
  "evidence",
  "deleteRequest",
  "deleteWait",
  "clientRound",
  "resourceInspection",
  "clientDelete",
  "resourceCleanup",
];
const polls = [
  "readySleep",
  "readyRequest",
  "deleteSleep",
  "deleteRequest",
  "auditSleep",
  "auditRequest",
];
const number = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const difference = (start, end) =>
  number(start) !== null && number(end) !== null ? number(end - start) : null;
const sum = (values) =>
  values.every((value) => number(value) !== null)
    ? values.reduce((a, b) => a + b, 0)
    : null;

export function phaseTiming(now = () => performance.now()) {
  const read = () => {
    try {
      return number(now());
    } catch {
      return null;
    }
  };
  const started = read();
  const values = {
    phases: Object.fromEntries(phases.map((name) => [name, null])),
    outcomes: Object.fromEntries(phases.map((name) => [name, "not_run"])),
    polls: Object.fromEntries(polls.map((name) => [name, { ms: 0, count: 0 }])),
    totalMs: null,
    unattributedMs: null,
  };
  return {
    values,
    async measure(name, action, group = "phases") {
      if (
        !(
          group === "phases" ? phases : group === "polls" ? polls : []
        ).includes(name)
      )
        return action();
      const begin = read();
      let outcome = "failed";
      try {
        const result = await action();
        outcome = "passed";
        return result;
      } finally {
        const elapsed = difference(begin, read());
        if (group === "polls") {
          const previous = values.polls[name];
          values.polls[name] = {
            ms: sum([previous.ms, elapsed]),
            count: previous.count + 1,
          };
        } else {
          values.phases[name] = elapsed;
          values.outcomes[name] = outcome;
        }
      }
    },
    finish() {
      values.totalMs = difference(started, read());
      const observed = phases
        .filter((name) => values.outcomes[name] !== "not_run")
        .map((name) => values.phases[name]);
      values.unattributedMs = difference(sum(observed), values.totalMs);
    },
  };
}

function clock(value) {
  return {
    totalMs: number(value?.totalMs),
    unattributedMs: number(value?.unattributedMs),
    phases: Object.fromEntries(
      phases.map((name) => [name, number(value?.phases?.[name])]),
    ),
    outcomes: Object.fromEntries(
      phases.map((name) => [
        name,
        ["passed", "failed", "not_run"].includes(value?.outcomes?.[name])
          ? value.outcomes[name]
          : "not_reported",
      ]),
    ),
    polls: Object.fromEntries(
      polls.map((name) => [
        name,
        {
          ms: number(value?.polls?.[name]?.ms),
          count:
            Number.isSafeInteger(value?.polls?.[name]?.count) &&
            value.polls[name].count >= 0
              ? value.polls[name].count
              : null,
        },
      ]),
    ),
  };
}

export function readinessTiming({
  rounds,
  completed,
  business,
  cleanup,
  cleanupMs,
}) {
  return {
    version: 1,
    required: 100,
    completed:
      Number.isSafeInteger(completed) && completed >= 0 && completed <= 100
        ? completed
        : null,
    business: ["passed", "failed", "not_reported"].includes(business)
      ? business
      : "not_reported",
    cleanup: ["passed", "failed", "not_reported"].includes(cleanup)
      ? cleanup
      : "not_reported",
    cleanupMs: number(cleanupMs),
    rounds: rounds
      .filter(
        (row) =>
          Number.isSafeInteger(row.index) && row.index >= 1 && row.index <= 100,
      )
      .map((row) => {
        const round = clock(row.round),
          deletion = clock(row.deletion),
          host = clock(row.host);
        return {
          index: row.index,
          round,
          deletion,
          host,
          clientCommandOverheadMs: {
            round: difference(round.totalMs, host.phases.clientRound),
            deletion: difference(deletion.totalMs, host.phases.clientDelete),
          },
          publication: {
            injectedDelayMs: difference(
              row.publication?.delayStartedAt,
              row.publication?.forwardedAt,
            ),
            upstreamRoundTripMs: difference(
              row.publication?.forwardedAt,
              row.publication?.upstreamCompletedAt,
            ),
            proxyFinalizationMs: difference(
              row.publication?.upstreamCompletedAt,
              row.publication?.completedAt,
            ),
          },
          serviceWorkMs: null,
        };
      }),
  };
}

export function timingMarkdown(report) {
  const seconds = (value) =>
    number(value) === null ? "n/a" : (value / 1000).toFixed(3);
  return [
    "## Readiness phase timing",
    "",
    `Completed rounds: ${report.completed}/${report.required}; business: ${report.business}; independent final cleanup: ${report.cleanup} (${seconds(report.cleanupMs)} s).`,
    "Client and host phases use their own monotonic clocks. Injection, upstream publication and polling observations overlap the ready/delete phases; do not add them to those phases. RPC elapsed time includes network and service work, not service CPU time; service-only work is unavailable. Unattributed time includes harness/evidence and resource joining, not an inferred service bottleneck.",
    "",
    "| Round | Host total (s) | Create | Ready context | ACK/ready observation | Initialize/session | First Prompt | Delete request/wait | Resource cleanup | Injected delay | Poll sleep |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.rounds.map((row) => {
      const r = row.round.phases,
        d = row.deletion.phases;
      return `| ${row.index} | ${[
        row.host.totalMs,
        r.create,
        r.readyContext,
        r.ready,
        sum([r.initialize, r.session]),
        r.prompt,
        sum([d.deleteRequest, d.deleteWait]),
        row.host.phases.resourceCleanup,
        row.publication.injectedDelayMs,
        sum([
          row.round.polls.readySleep.ms,
          row.round.polls.auditSleep.ms,
          row.deletion.polls.deleteSleep.ms,
        ]),
      ]
        .map(seconds)
        .join(" | ")} |`;
    }),
    "",
  ].join("\n");
}
