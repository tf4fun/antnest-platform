import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import {
  admissionCases,
  admissionResponse,
  assertAdmissionResult,
  assertAdmissionSources,
  loginAdmissionChecks,
} from "./login-admission.mjs";

const counters = (password = 0, oidc = 0) => ({
  calls: { password, oidc_start: oidc },
  issued: 3,
  rotations: 1,
  revocationCalls: 2,
  revocations: 2,
});
const refused = () =>
  new Response(
    JSON.stringify({
      code: "login_rate_limited",
      message: "Too many login attempts",
    }),
    {
      status: 429,
      headers: { "Cache-Control": "no-store", "Retry-After": "300" },
    },
  );

test("admission evidence accepts an exact edge refusal without upstream work", async () => {
  const step = admissionCases.find((row) => row.status === 429);
  const observed = await admissionResponse(refused(), step.flow);
  assertAdmissionResult(step, counters(), counters(), observed);
});

test("a refused request cannot hide upstream work or Cookie writes", async () => {
  const step = admissionCases.find((row) => row.status === 429);
  const observed = await admissionResponse(refused(), step.flow);
  assert.throws(() =>
    assertAdmissionResult(step, counters(), counters(0, 1), observed),
  );
  const response = refused();
  response.headers.set("Set-Cookie", "__Host-antnest_session=private; Path=/");
  assert.throws(() =>
    assertAdmissionResult(step, counters(), counters(), {
      ...observed,
      cookies: [{ name: "__Host-antnest_session" }],
    }),
  );
  const withCookie = await admissionResponse(response, step.flow);
  assert.throws(() =>
    assertAdmissionResult(step, counters(), counters(), withCookie),
  );
});

test("Identity throttling cannot substitute for the edge refusal", async () => {
  const step = admissionCases.find((row) => row.status === 429);
  for (const body of [
    {
      code: "credential_rate_limited",
      message: "Too many password attempts",
      retryable: true,
    },
    {
      code: "login_rate_limited",
      message: "Too many login attempts",
      retryable: true,
    },
  ]) {
    const response = refused();
    const observed = await admissionResponse(
      new Response(JSON.stringify(body), response),
      step.flow,
    );
    assert.throws(() =>
      assertAdmissionResult(step, counters(), counters(), observed),
    );
  }
});

test("OIDC success requires one secure binding Cookie and exactly its owning RPC", async () => {
  const step = admissionCases.find(
    (row) => row.flow === "oidc_start" && row.status === 200,
  );
  const raw = {
    authorization_url:
      "https://provider.example.test/authorize?state=private-state",
    expires_at: new Date(Date.now() + 60000).toISOString(),
  };
  const headers = {
    "Cache-Control": "no-store",
    "Set-Cookie":
      "__Host-antnest_oidc=private-binding; Path=/; Secure; HttpOnly; SameSite=Lax",
  };
  const observed = await admissionResponse(
    new Response(JSON.stringify(raw), { headers }),
    step.flow,
  );
  assertAdmissionResult(step, counters(), counters(0, 1), observed);
  assert(!JSON.stringify(observed).includes("private-"));
  assert.throws(() =>
    assertAdmissionResult(step, counters(), counters(1, 1), observed),
  );
  assert.throws(() =>
    assertAdmissionResult(step, counters(), counters(), observed),
  );
  assert.throws(() =>
    assertAdmissionResult(step, counters(), counters(0, 1), {
      ...observed,
      cookies: [],
    }),
  );
  assert.throws(() =>
    assertAdmissionResult(step, counters(), counters(0, 1), {
      ...observed,
      cookies: [...observed.cookies, { name: "__Host-antnest_session" }],
    }),
  );
});

test("source evidence rejects one shared address and a missing Gateway receipt", () => {
  const events = admissionCases.map((row) => ({
    client_address: row.source === "A" ? "192.0.2.1" : "172.20.0.3",
    route:
      row.flow === "password"
        ? "/api/session/login"
        : "/api/session/oidc/start",
    status_code: row.status,
  }));
  const before = structuredClone(events);
  const evidence = assertAdmissionSources(events, "172.20.0.3");
  assert.equal(evidence.source_a, "192.0.2.1");
  assert.equal(evidence.source_b, "172.20.0.3");
  assert.deepEqual(events, before);
  assert.throws(() =>
    assertAdmissionSources(
      events.map((row) => ({ ...row, client_address: "172.20.0.3" })),
      "172.20.0.3",
    ),
  );
  assert.throws(() => assertAdmissionSources(events.slice(1), "172.20.0.3"));
  assert.throws(() => assertAdmissionSources(events, "172.20.0.4"));
});

test("container receipts never serialize arbitrary response headers", async () => {
  const response = refused();
  response.headers.set("Cache-Control", "private-header-canary");
  response.headers.set("Retry-After", "private-header-canary");
  const observed = await admissionResponse(response, "oidc_start");
  assert(!JSON.stringify(observed).includes("private-header-canary"));
  const step = admissionCases.find((row) => row.status === 429);
  assert.throws(() =>
    assertAdmissionResult(step, counters(), counters(), observed),
  );
});

test("malformed response bodies produce a fixed error without private excerpts", async () => {
  await assert.rejects(
    admissionResponse(new Response("private-body-canary"), "oidc_start"),
    (error) => {
      assert.equal(
        error.message,
        "Gateway admission response body is not valid JSON",
      );
      assert(!inspect(error).includes("private-body-canary"));
      return true;
    },
  );
});

const admissionSequence = (duration) => {
  const receipts = new Map();
  const state = counters();
  let index = 0;
  const times = [1000, 1000 + duration];
  return {
    receipts,
    run: () =>
      loginAdmissionChecks({
        clock: () => times.shift(),
        readEvidence: async () => structuredClone(state),
        recordEvidence: (name, value) => receipts.set(name, value),
        request: async (source, flow) => {
          const step = admissionCases[index++];
          assert.equal(source, step.source);
          assert.equal(flow, step.flow);
          if (step.status !== 429) state.calls[flow]++;
          return {
            status: step.status,
            canonicalBody: true,
            cacheControl: "no-store",
            retryAfter: step.status === 429 ? "300" : null,
            cookies:
              step.status === 200
                ? [
                    {
                      name: "__Host-antnest_oidc",
                      valuePresent: true,
                      secure: true,
                      httpOnly: true,
                      sameSiteLax: true,
                      rootPath: true,
                      hostOnly: true,
                    },
                  ]
                : [],
          };
        },
      }),
  };
};

test("natural expiry cannot substitute for capacity eviction evidence", async () => {
  for (const duration of [300000, 300001]) {
    const sequence = admissionSequence(duration);
    await assert.rejects(
      sequence.run(),
      /Gateway admission sequence must finish within its fixed window/,
    );
    assert.equal(
      sequence.receipts.get("login-admission-timing.json").duration_ms,
      duration,
    );
  }
});

test("eviction evidence records the monotonic duration inside the fixed window", async () => {
  const sequence = admissionSequence(299999);
  const result = await sequence.run();
  assert.deepEqual(result.timing, {
    start_monotonic_ms: 1000,
    end_monotonic_ms: 300999,
    duration_ms: 299999,
    window_ms: 300000,
  });
  assert.deepEqual(
    sequence.receipts.get("login-admission-timing.json"),
    result.timing,
  );
  assert.equal(result.checks, admissionCases.length);
});
