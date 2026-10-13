import assert from "node:assert/strict";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const admissionWindowMinutes = 5;
const admissionWindowMs = admissionWindowMinutes * 60 * 1000;
const admissionRetryAfter = String(admissionWindowMs / 1000);
export const admissionConfiguration = {
  ANTNEST_EDGE_LOGIN_WINDOW: `${admissionWindowMinutes}m`,
  ANTNEST_EDGE_LOGIN_SOURCE_MAX: "2",
  ANTNEST_EDGE_LOGIN_ACCOUNT_MAX: "1",
  ANTNEST_EDGE_LOGIN_MAX_KEYS: "1",
  ANTNEST_EDGE_OIDC_START_SOURCE_MAX: "2",
};

export const admissionCases = [
  {
    name: "password namespace",
    source: "A",
    flow: "password",
    email: "oidc:workforce",
    status: 401,
  },
  { name: "OIDC after password", source: "A", flow: "oidc_start", status: 200 },
  {
    name: "OIDC final allowance",
    source: "A",
    flow: "oidc_start",
    status: 200,
  },
  {
    name: "OIDC retained source refusal",
    source: "A",
    flow: "oidc_start",
    status: 429,
  },
  {
    name: "password after OIDC exhaustion",
    source: "A",
    flow: "password",
    email: "after-oidc@example.test",
    status: 401,
  },
  {
    name: "password eviction does not reset OIDC",
    source: "A",
    flow: "oidc_start",
    status: 429,
  },
  {
    name: "password retained source refusal",
    source: "A",
    flow: "password",
    email: "third@example.test",
    status: 429,
  },
  {
    name: "new source with exhausted account",
    source: "B",
    flow: "password",
    email: "after-oidc@example.test",
    status: 429,
  },
  {
    name: "account refusal did not evict source A",
    source: "A",
    flow: "password",
    email: "third@example.test",
    status: 429,
  },
  {
    name: "source B OIDC admitted",
    source: "B",
    flow: "oidc_start",
    status: 200,
  },
  {
    name: "new password source evicts oldest",
    source: "B",
    flow: "password",
    email: "source-b@example.test",
    status: 401,
  },
  {
    name: "oldest password keys can restart",
    source: "A",
    flow: "password",
    email: "after-oidc@example.test",
    status: 401,
  },
  {
    name: "oldest OIDC source can restart",
    source: "A",
    flow: "oidc_start",
    status: 200,
  },
  {
    name: "recreated OIDC final allowance",
    source: "A",
    flow: "oidc_start",
    status: 200,
  },
  {
    name: "recreated OIDC source refusal",
    source: "A",
    flow: "oidc_start",
    status: 429,
  },
  {
    name: "retained password account refusal",
    source: "A",
    flow: "password",
    email: "after-oidc@example.test",
    status: 429,
  },
];

const route = (flow) => {
  assert(
    ["password", "oidc_start"].includes(flow),
    "unexpected admission flow",
  );
  return flow === "password" ? "/api/session/login" : "/api/session/oidc/start";
};

// The container client prints only this projection. Authorization URLs, state,
// cookie values and arbitrary upstream text must never enter its receipts.
export async function admissionResponse(response, flow) {
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error("Gateway admission response body is not valid JSON");
  }
  const keys = Object.keys(value ?? {})
    .sort()
    .join(",");
  let canonicalBody = false;
  if (response.status === 200 && flow === "oidc_start") {
    canonicalBody =
      keys === "authorization_url,expires_at" &&
      typeof value.authorization_url === "string" &&
      URL.canParse(value.authorization_url) &&
      new URL(value.authorization_url).protocol === "https:" &&
      Boolean(new URL(value.authorization_url).searchParams.get("state")) &&
      Date.parse(value.expires_at) > Date.now();
  } else if (response.status === 401) {
    canonicalBody =
      keys === "code,message" &&
      value.code === "unauthenticated" &&
      value.message === "Email or password is incorrect";
  } else if (response.status === 429) {
    canonicalBody =
      keys === "code,message" &&
      value.code === "login_rate_limited" &&
      value.message === "Too many login attempts";
  }
  const cookies = response.headers.getSetCookie().map((raw) => {
    const [pair, ...parts] = raw.split(";").map((part) => part.trim());
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator);
    const attributes = new Map(
      parts.map((part) => {
        const index = part.indexOf("=");
        return index < 0
          ? [part.toLowerCase(), true]
          : [part.slice(0, index).toLowerCase(), part.slice(index + 1)];
      }),
    );
    return {
      name: [
        "__Host-antnest_oidc",
        "__Host-antnest_session",
        "__Host-antnest_csrf",
      ].includes(name)
        ? name
        : "unexpected",
      valuePresent: separator >= 0 && pair.length > separator + 1,
      secure: attributes.has("secure"),
      httpOnly: attributes.has("httponly"),
      sameSiteLax: String(attributes.get("samesite")).toLowerCase() === "lax",
      rootPath: attributes.get("path") === "/",
      hostOnly: !attributes.has("domain"),
    };
  });
  const header = (name, expected) => {
    const actual = response.headers.get(name);
    return actual === null || actual === expected ? actual : "unexpected";
  };
  return {
    status: response.status,
    canonicalBody,
    cacheControl: header("cache-control", "no-store"),
    retryAfter: header("retry-after", admissionRetryAfter),
    cookies,
  };
}

export function assertAdmissionResult(step, before, after, observed) {
  assert.equal(observed.status, step.status, step.name);
  assert.equal(observed.canonicalBody, true, step.name + ": response shape");
  assert.equal(observed.cacheControl, "no-store");
  assert.equal(
    observed.retryAfter,
    step.status === 429 ? admissionRetryAfter : null,
  );
  for (const flow of ["password", "oidc_start"])
    assert.equal(
      after.calls[flow] - before.calls[flow],
      flow === step.flow && step.status !== 429 ? 1 : 0,
      step.name + ": owning RPC count for " + flow,
    );
  for (const field of ["issued", "rotations", "revocationCalls", "revocations"])
    assert.equal(
      after[field],
      before[field],
      step.name + ": unexpected " + field,
    );
  if (step.status === 200) {
    assert.equal(observed.cookies.length, 1, "OIDC browser binding Cookie");
    assert.deepEqual(observed.cookies[0], {
      name: "__Host-antnest_oidc",
      valuePresent: true,
      secure: true,
      httpOnly: true,
      sameSiteLax: true,
      rootPath: true,
      hostOnly: true,
    });
  } else {
    assert.deepEqual(observed.cookies, [], "refusal must not write a Cookie");
  }
}

export function assertAdmissionSources(events, sourceB) {
  assert(isIP(sourceB), "container B must have a real IP");
  assert.equal(
    events.length,
    admissionCases.length,
    "all Gateway receipts required",
  );
  const addresses = [...new Set(events.map((event) => event.client_address))];
  assert.equal(
    addresses.length,
    2,
    "two actual selected source addresses required",
  );
  assert(
    addresses.includes(sourceB),
    "container B did not reach Gateway directly",
  );
  const sourceA = addresses.find((value) => value !== sourceB);
  assert(isIP(sourceA), "source A must have a real selected IP");
  const grouped = (rows) =>
    Object.entries(
      rows.reduce((counts, key) => {
        counts[key] = (counts[key] ?? 0) + 1;
        return counts;
      }, {}),
    ).sort(([a], [b]) => a.localeCompare(b));
  assert.deepEqual(
    grouped(
      events.map((event) =>
        [
          event.client_address === sourceB ? "B" : "A",
          event.route,
          event.status_code,
        ].join("/"),
      ),
    ),
    grouped(
      admissionCases.map((step) =>
        [step.source, route(step.flow), step.status].join("/"),
      ),
    ),
    "Gateway source/status receipts must match the actual requests",
  );
  return {
    source_a: sourceA,
    source_b: sourceB,
    gateway_receipts: events.length,
  };
}

export async function requestAdmission({ url, origin, flow, body, signal }) {
  const response = await fetch(url + route(flow), {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal,
  });
  return admissionResponse(response, flow);
}

export async function loginAdmissionChecks({
  request,
  readEvidence,
  recordEvidence,
  clock = () => performance.now(),
}) {
  const observations = [];
  const started = clock();
  for (const step of admissionCases) {
    const before = await readEvidence();
    const body =
      step.flow === "password"
        ? {
            organization_slug: "auth-test",
            email: step.email,
            password: "deliberately-wrong-admission-password",
          }
        : { organization_slug: "auth-test", provider_name: "workforce" };
    const observed = await request(step.source, step.flow, body);
    const after = await readEvidence();
    const { name, source, flow, status } = step;
    observations.push({ name, source, flow, status, observed, before, after });
    recordEvidence("login-admission-observations.json", observations);
    assertAdmissionResult(step, before, after, observed);
  }
  const finished = clock();
  const timing = {
    start_monotonic_ms: started,
    end_monotonic_ms: finished,
    duration_ms: finished - started,
    window_ms: admissionWindowMs,
  };
  recordEvidence("login-admission-timing.json", timing);
  assert(
    Number.isFinite(timing.duration_ms) &&
      timing.duration_ms >= 0 &&
      timing.duration_ms < admissionWindowMs,
    "Gateway admission sequence must finish within its fixed window",
  );
  return {
    checks: observations.length,
    final: observations.at(-1).after,
    timing,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const input = JSON.parse(process.argv[2]);
  const observed = await requestAdmission({
    ...input,
    signal: AbortSignal.timeout(10000),
  });
  console.log(JSON.stringify(observed));
}
