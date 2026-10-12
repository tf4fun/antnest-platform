import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayClient, assertNoStore } from "./support.mjs";
import { assertSecretFree } from "./evidence.mjs";
import { assertOrganizationSession } from "./organization-session.mjs";
import {
  assertWorkspaceBootstrap,
  assertWorkspaceDocument,
} from "./organization-workspace.mjs";
import { verifyIdentityEvidence } from "./trace.mjs";
import { resolveObservationConfig } from "../observability/resolve-config.mjs";
import {
  evidenceDirectory,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { searchJaegerTraces } from "../../support/jaeger-search.mjs";
import {
  displaySurfaces,
  inspectOrganizationRead,
  inspectEmptySessionFeed,
  inspectOrganizationRefresh,
  assertOrganizationTimeline,
  assertDisplayFeedCoverage,
  selectSessionFeedRequests,
} from "./organization-freshness.mjs";

const stablePrincipal = ({
  organization_slug,
  organization_name,
  ...principal
}) => principal;

export function assertDisplayReadHeaders(headers, surface) {
  assert(displaySurfaces[surface], "unknown display surface");
  if (surface === "ssr") {
    const directives = new Set(
      (headers.get("cache-control") ?? "")
        .toLowerCase()
        .split(",")
        .map((s) => s.trim()),
    );
    assert.deepEqual(directives, new Set(["private", "no-store"]));
  } else assertNoStore(headers);
  assert.equal(
    headers.getSetCookie().length,
    0,
    "passive display read wrote Cookie",
  );
}

import { observeBoundedRevocation as observeDisplayRejection } from "../../support/bounded-revocation.mjs";
export { observeDisplayRejection };

export async function searchOrganizationFeed(
  jaeger,
  { directory, earliest, latest, fetchImpl },
) {
  assert(
    Number.isFinite(earliest) && Number.isFinite(latest) && earliest <= latest,
  );
  // Trace timestamps are microseconds; Jaeger search boundaries use milliseconds.
  // Round outward, then keep the existing exact CLIENT-time selection. Evidence
  // collection must not pull a still-exporting feed from later wall-clock time.
  const now = Math.ceil(latest / 1000);
  const lookback = Math.max(1, now - Math.floor(earliest / 1000));
  const result = await searchJaegerTraces(
    jaeger,
    new URLSearchParams({
      service: "identity-service",
      tags: JSON.stringify({ "rpc.method": "list_session_revocations" }),
      limit: "1000",
      lookback: `${lookback}ms`,
    }),
    { fetchImpl, now },
  );
  writeEvidenceFile(
    directory,
    "organization-feed-search.json",
    JSON.stringify(result),
  );
  assert(result.length < 1000, "Organization trace search may be truncated");
  return result;
}

// Six distinct login tokens isolate the three actual surfaces and the quiet
// expiry branch. Bootstrap and SSR otherwise share workspace/empty-Agent.
export async function prepareOrganizationFreshness({
  gateway,
  project,
  docker,
  login,
  principal,
  original,
  agentID,
  secrets,
  directory,
}) {
  directory = evidenceDirectory(directory);
  assert(directory, "Organization freshness evidence directory required");
  const rows = JSON.parse(
    await docker(["inspect", `${project}-edge-gateway-1`]),
  );
  assert.equal(rows.length, 1);
  const deployed = rows[0];
  assert.equal(deployed.Config.Labels["com.docker.compose.project"], project);
  assert.equal(
    deployed.Config.Labels["com.docker.compose.service"],
    "edge-gateway",
  );
  assert.equal(deployed.State.Running, true);
  const settings = {};
  for (const key of [
    "ANTNEST_EDGE_RESOLVE_CACHE_TTL",
    "ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT",
  ]) {
    const values = deployed.Config.Env.filter((v) => v.startsWith(key + "="));
    assert(values.length <= 1);
    if (values.length) settings[key] = values[0].slice(key.length + 1);
  }
  const config = resolveObservationConfig(settings, {});
  assert.equal(
    config.resolveTTLMS,
    10000,
    "Organization cache admission requires the default 10s TTL",
  );
  assert.equal(config.captureRpcContent, false);
  const record = {
    ttlMS: config.resolveTTLMS,
    captureRpcContent: false,
    startedEpochMS: Date.now(),
    original,
    reads: [],
  };
  const save = () =>
    writeEvidenceFile(
      directory,
      "organization-freshness-reads.json",
      JSON.stringify(record),
    );
  const plans = [];
  const tokens = new Set();
  for (const surface of Object.keys(displaySurfaces))
    for (const mode of ["continuous", "expiry"]) {
      const client = new GatewayClient(gateway);
      const actual = await login(client);
      assert.deepEqual(stablePrincipal(actual), stablePrincipal(principal));
      assert(
        client.accessToken && !tokens.has(client.accessToken),
        "display scopes reused a login token",
      );
      tokens.add(client.accessToken);
      plans.push({ surface, mode, client, cookie: client.cookie });
    }

  async function read(plan, phase, changed) {
    const { surface, mode, client, cookie } = plan;
    const item = { surface, mode, phase, startedMS: performance.now() };
    record.reads.push(item);
    save();
    try {
      const response = await client.request(displaySurfaces[surface].path, {
        responseType: surface === "ssr" ? "text" : "json",
      });
      item.completedMS = performance.now();
      item.traceID = response.traceID;
      item.status = response.status;
      assert.match(item.traceID ?? "", /^[a-f0-9]{32}$/u);
      assertDisplayReadHeaders(response.headers, surface);
      assert.equal(
        client.cookie,
        cookie,
        "passive display read changed Cookie",
      );
      item.cookie_unchanged = true;
      assertSecretFree(
        typeof response.body === "string"
          ? response.body
          : JSON.stringify(response.body),
        secrets,
      );
      let display;
      if (surface === "session")
        display = {
          name: response.body?.principal?.organization_name,
          slug: response.body?.principal?.organization_slug,
        };
      else {
        let payload = response.body;
        if (surface === "ssr") {
          const embedded = payload.match(
            /id="workspace-bootstrap"[^>]*>(.*?)<\/script>/s,
          );
          assert(embedded, "SSR display bootstrap missing");
          payload = JSON.parse(embedded[1]).bootstrap;
        }
        display = {
          name: payload?.principal?.organizationName,
          slug: payload?.principal?.organizationSlug,
        };
      }
      const expected = [original, changed].find(
        (row) => row && row.name === display.name && row.slug === display.slug,
      );
      assert(expected, "display returned an unknown Organization snapshot");
      if (surface === "session")
        assert.deepEqual(
          stablePrincipal(
            assertOrganizationSession(response.body, "session", expected),
          ),
          stablePrincipal(principal),
        );
      else if (surface === "bootstrap")
        assertWorkspaceBootstrap(
          response.body,
          principal,
          expected,
          [agentID],
          secrets,
        );
      else
        assertWorkspaceDocument(
          response.body,
          principal,
          expected,
          [agentID],
          secrets,
        );
      item.organization = display;
      item.snapshot = expected === original ? "original" : "renamed";
      item.identity_scope_unchanged = true;
    } catch (error) {
      item.completedMS ??= performance.now();
      item.failure = error?.name ?? "Error";
      throw error;
    } finally {
      save();
    }
  }
  for (const plan of plans) await read(plan, "warm");
  for (let round = 0; round < 2; round++)
    for (const plan of plans) await read(plan, "before-rename");
  // A slow setup must fail instead of silently exercising background refresh
  // on the scope reserved for natural expiry.
  for (const plan of plans) {
    const group = record.reads.filter(
      (r) => r.surface === plan.surface && r.mode === plan.mode,
    );
    assert(
      group.at(-1).completedMS < group[0].startedMS + record.ttlMS / 2,
      "display prewarming exceeded half TTL",
    );
  }
  return {
    beginRename() {
      record.renameStartedMS = performance.now();
      save();
    },
    async afterRename(changed, committedMS) {
      record.renamed = changed;
      record.renameCommittedMS = committedMS;
      record.renameCommitTimeKind = "sql_command_completion_upper_bound";
      record.renameReadbackMS = performance.now();
      save();
      const deadline = committedMS + record.ttlMS;
      while (performance.now() < deadline) {
        for (const plan of plans.filter((p) => p.mode === "continuous"))
          await read(plan, "after-rename", changed);
        await delay(Math.min(1000, Math.max(0, deadline - performance.now())));
      }
      for (const plan of plans) await read(plan, "expired", changed);
    },
    async collect(jaeger) {
      const resolutions = await verifyIdentityEvidence(
        jaeger,
        record.reads.map((r) => ({
          traceID: r.traceID,
          surface: r.surface,
          ttlMS: record.ttlMS,
        })),
        secrets,
        { directory, inspect: inspectOrganizationRead },
      );
      const timeline = assertOrganizationTimeline({ ...record, resolutions });
      const earliest =
        Math.min(
          ...resolutions.map((r) => r.root_started_us),
          ...resolutions
            .filter((r) => r.source === "cache")
            .map((r) => r.decision_started_us - r.proof_age_ms * 1000),
        ) - 2000000;
      const latest =
        Math.max(...resolutions.map((r) => r.root_completed_us)) + 2000000;
      const search = async (name, parameters) => {
        const result = await searchJaegerTraces(
          jaeger,
          new URLSearchParams({
            ...parameters,
            limit: "1000",
            lookback: `${Math.ceil(Date.now() - record.startedEpochMS + 5000)}ms`,
          }),
        );
        writeEvidenceFile(directory, name, JSON.stringify(result));
        assert(
          result.length < 1000,
          "Organization trace search may be truncated",
        );
        return result;
      };
      const feedTraces = await searchOrganizationFeed(jaeger, {
        directory,
        earliest,
        latest,
      });
      const feedExpected = selectSessionFeedRequests(
        feedTraces,
        earliest,
        latest,
      );
      const feeds = await verifyIdentityEvidence(
        jaeger,
        feedExpected,
        secrets,
        { directory, inspect: inspectEmptySessionFeed },
      );
      const feedCoverage = assertDisplayFeedCoverage(
        resolutions,
        feeds,
        record.ttlMS,
      );
      const refreshTraces = await search("organization-refresh-search.json", {
        service: "edge-gateway",
        operation: "gateway.identity.resolve.refresh",
      });
      const continuous = new Map(
        record.reads
          .filter((r) => r.mode === "continuous")
          .map((r) => [r.traceID, r]),
      );
      const refreshExpected = [];
      for (const trace of refreshTraces)
        for (const root of trace.spans.filter(
          (s) => s.operationName === "gateway.identity.resolve.refresh",
        )) {
          const link = root.references.find(
            (r) => r.refType === "FOLLOWS_FROM",
          );
          const trigger = continuous.get(link?.traceID);
          if (!trigger) continue;
          const resolution = resolutions.find(
            (r) => r.trace_id === trigger.traceID,
          );
          refreshExpected.push({
            traceID: trace.traceID,
            triggerTraceID: trigger.traceID,
            triggerDecisionID: resolution.decision_span_id,
            profile: displaySurfaces[trigger.surface].profile,
            surface: trigger.surface,
            ttlMS: record.ttlMS,
          });
        }
      for (const surface of Object.keys(displaySurfaces))
        assert(
          refreshExpected.some((r) => r.surface === surface),
          "actual display background refresh missing",
        );
      const refreshes = await verifyIdentityEvidence(
        jaeger,
        refreshExpected,
        secrets,
        { directory, inspect: inspectOrganizationRefresh },
      );
      const result = {
        timeline,
        feed_coverage: feedCoverage,
        reads: record.reads,
        resolutions,
        feeds,
        refreshes,
      };
      writeEvidenceFile(
        directory,
        "organization-freshness-admission.json",
        JSON.stringify(result),
      );
      return result;
    },
  };
}
