import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import { member } from "../workspace-closeout/c4-setup.mjs";
import { gatewayOrigin } from "../../support/gateway-origin.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { inspectLoadWire, inspectLoadResponse } from "./resolve-cache-load.mjs";
import { collectResolveLoad } from "./resolve-cache-collect.mjs";
import { createLoadOwnerLifecycle } from "./resolve-cache-owner-drain.mjs";
import { assertLoadAdmission } from "../../support/resolve-cache-admission.mjs";

export async function verifyResolveLoad(
  { config, fixture, settings, signal, output, docker, compose, images },
  {
    createClient = (base) => new GatewayClient(base),
    createOwner = createLoadOwnerLifecycle,
    measure = measureResolveLoad,
    collect = collectResolveLoad,
    admit = assertLoadAdmission,
    write = writeEvidenceFile,
  } = {},
) {
  const client = createClient(config.gateway);
  const login = await client.request("/api/session/login", { body: member });
  const principal = login?.body?.principal;
  assert(
    typeof principal?.organization_id === "string" &&
      principal.organization_id.length > 0 &&
      typeof principal.user_id === "string" &&
      principal.user_id.length > 0 &&
      principal.user_id === fixture.ownerID &&
      principal.organization_slug === member.organization_slug &&
      principal.organization_role === "member" &&
      principal.active === true,
    "load login must identify the actual active member and Agent owner",
  );
  const ownerScope = {
    organization_id: principal.organization_id,
    user_id: principal.user_id,
    agent_id: fixture.agentID,
  };
  const secrets = [member.password, client.cookie, ...client.cookies.values()];
  const owner = await createOwner({
    docker,
    compose,
    images,
    environment: config.env,
    project: config.project,
    agentID: fixture.agentID,
    output,
    secrets,
    signal,
  });
  const wire = {};
  const failures = [];
  try {
    await measure({
      gateway: config.gateway,
      agentID: fixture.agentID,
      cookie: client.cookie,
      secrets,
      signal,
      wire,
    });
  } catch (error) {
    failures.push(error);
  }
  try {
    assertSecretFree(JSON.stringify(wire), secrets);
    await write(
      output,
      "load-wire.private.json",
      JSON.stringify(wire, null, 2),
    );
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(
      failures,
      "Bridge load measurement and archive failed",
    );
  let ownerReceipt;
  const result = await owner.collect(wire, async (receipt) => {
    ownerReceipt = receipt;
    return collect(config.jaeger, wire, fixture.agentID, settings, secrets, {
      signal,
      directory: join(output, "load"),
      ownerLifecycle: receipt,
      ownerScope,
    });
  });
  assert.equal(
    ownerReceipt?.restored,
    true,
    "load owner restoration incomplete",
  );
  assert(
    result.background_refreshes >= 1,
    "half-TTL load did not witness actual refresh",
  );
  const completed = { ...result, owner_lifecycle: ownerReceipt };
  assert.deepEqual(
    completed.owner_cleanup?.owner_scope,
    ownerScope,
    "load cleanup differs from actual authenticated owner",
  );
  admit(completed);
  const raw = JSON.stringify(completed, null, 2);
  assertSecretFree(raw, secrets);
  await write(join(output, "load"), "load-completed.json", raw);
  return completed;
}

// The caller supplies a freshly provisioned Agent with no prior Bridge owner.
// No activity, view, SSE or extra initialization request is sent in this window.
// The trace gate independently proves the first actual HTTP request initialized
// ACP and the final actual request triggered the background refresh.
export async function measureResolveLoad({
  gateway,
  agentID,
  cookie,
  signal,
  secrets = [],
  wire = {},
  request = fetch,
  now = () => performance.now(),
  wait = delay,
}) {
  assert(
    typeof cookie === "string" && cookie.length > 0,
    "load session missing",
  );
  const privateValues = [
    cookie,
    ...secrets,
    ...cookie.split(";").map((part) => {
      const separator = part.indexOf("=");
      return separator < 0 ? "" : part.slice(separator + 1).trim();
    }),
  ];
  const path = `/api/app/workspace/v1/agents/${encodeURIComponent(agentID)}/sessions`;
  const url = new URL(path, gateway).href;
  const deadline = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(8000),
  ]);
  Object.assign(wire, {
    policy_revision: 4,
    transport: "http",
    profile: "workspace",
    agent_id: agentID,
    started_at: now(),
    requests: [],
  });
  try {
    for (let index = 0; index < 100; index++) {
      if (index === 99) {
        // Initial Resolve starts before the first body finishes, so this also
        // crosses its half TTL without a cross-host wall-clock assumption.
        const remaining = wire.requests[0].completed_at + 5001 - now();
        if (remaining > 0) {
          try {
            await wait(remaining, undefined, { signal: deadline });
          } catch {
            throw new Error("Bridge load delay cancelled or failed");
          }
        }
      }
      assert(!deadline.aborted, "Bridge load cancelled");
      const row = {
        method: "GET",
        path,
        started_at: now(),
        body_complete: false,
      };
      wire.requests.push(row);
      let response, raw;
      try {
        response = await request(url, {
          method: "GET",
          redirect: "manual",
          headers: { Cookie: cookie, Origin: gatewayOrigin(gateway) },
          signal: deadline,
        });
      } catch {
        throw new Error("Bridge load HTTP request failed");
      }
      row.headers_at = now();
      if (Number.isInteger(response.status)) row.status = response.status;
      try {
        raw = await response.text();
      } catch {
        throw new Error("Bridge load response body failed");
      }
      row.body_bytes = Buffer.byteLength(raw);
      row.body_complete = true;
      row.completed_at = now();
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        throw new Error("Bridge load response is not JSON");
      }
      const candidate = {
        ...row,
        body,
        trace_id: response.headers.get("x-antnest-trace-id"),
        content_type: response.headers.get("content-type"),
        cache_control: response.headers.get("cache-control"),
        set_cookie_count: response.headers.getSetCookie().length,
      };
      // Validate before retaining any remote strings. Failed responses leave
      // only timing, status and byte counts, never a body or arbitrary headers.
      assertSecretFree(JSON.stringify(candidate), privateValues);
      inspectLoadResponse(candidate);
      Object.assign(row, candidate);
      assert(!deadline.aborted, "Bridge load cancelled");
    }
  } finally {
    wire.completed_at = now();
  }
  inspectLoadWire(wire);
  return wire;
}
