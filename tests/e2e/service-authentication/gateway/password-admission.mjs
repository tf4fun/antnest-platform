import assert from "node:assert/strict";

const busy = {
  code: "credential_busy",
  message: "Password verification is busy",
  retryable: true,
};
const rate = {
  code: "credential_rate_limited",
  message: "Too many password attempts",
  retryable: true,
};
const unavailable = {
  code: "identity_unavailable",
  message: "Identity Service is unavailable",
};

export const passwordFailures = [
  {
    name: "busy",
    status: 503,
    body: busy,
    retry: ["1"],
    expected: busy,
    retryAfter: "1",
  },
  {
    name: "rate-first",
    status: 429,
    body: rate,
    retry: ["1"],
    expected: rate,
    retryAfter: "1",
  },
  {
    name: "rate-max",
    status: 429,
    body: rate,
    retry: ["900"],
    expected: rate,
    retryAfter: "900",
  },
  { name: "missing-header", status: 429, body: rate, retry: [] },
  { name: "duplicate-header", status: 429, body: rate, retry: ["1", "1"] },
  { name: "wrong-status", status: 401, body: busy, retry: ["1"] },
  {
    name: "false-retryable",
    status: 503,
    body: { ...busy, retryable: false },
    retry: ["1"],
  },
  {
    name: "unknown-field",
    status: 503,
    body: { ...busy, token: "private-password-canary" },
    retry: ["1"],
  },
  { name: "wrong-busy-delay", status: 503, body: busy, retry: ["2"] },
  {
    name: "mixed-success",
    status: 200,
    body: busy,
    retry: ["1"],
    mixedSuccess: true,
  },
];

export function assertPasswordCaseCounts(value) {
  const expected = Object.fromEntries(
    ["local-login", "change-local-password"].flatMap((rpc) =>
      passwordFailures.map(({ name }) => [`${rpc}/${name}`, 1]),
    ),
  );
  assert.deepEqual(
    value.cases,
    expected,
    "each password failure must reach Identity exactly once through Gateway shutdown",
  );
}

export async function passwordAdmissionChecks({
  request,
  login,
  fixture,
  readEvidence,
  recordEvidence,
}) {
  const observations = [];
  let checks = 0;
  for (const rpc of ["local-login", "change-local-password"]) {
    for (const row of passwordFailures) {
      const before = await readEvidence();
      const path =
        rpc === "local-login" ? "/api/session/login" : "/api/session/password";
      const body =
        rpc === "local-login"
          ? {
              organization_slug: "auth-test",
              email: `password-admission-${row.name}@example.test`,
              password: fixture.password,
            }
          : {
              current_password: fixture.password,
              new_password: `admission-case-${row.name}-replacement`,
            };
      const { response, value } = await request(path, {
        method: "POST",
        body,
        status: row.expected ? row.status : 503,
      });
      assert.deepEqual(value, row.expected ?? unavailable);
      assert.equal(response.headers.get("Retry-After"), row.retryAfter ?? null);
      const after = await readEvidence();
      assert.equal(after.calls[rpc] - before.calls[rpc], 1);
      const other =
        rpc === "local-login" ? "change-local-password" : "local-login";
      assert.equal(after.calls[other], before.calls[other]);
      assert.equal(after.issued, before.issued);
      assert.equal(after.rotations, before.rotations);
      assert.equal(after.revocationCalls, before.revocationCalls);
      assert.equal(after.revocations, before.revocations);
      assert.equal(after.cases[`${rpc}/${row.name}`], 1);
      await request("/api/session");
      observations.push({
        rpc,
        name: row.name,
        status: response.status,
        retryAfter: response.headers.get("Retry-After"),
        before,
        after,
        sessionStillUsable: true,
      });
      checks++;
    }
  }
  const recovered = await login();
  await request("/api/session", { session: recovered });
  await request("/api/session", {
    session: recovered,
    method: "DELETE",
    status: 204,
    cookies: true,
  });
  await request("/api/session");
  assertPasswordCaseCounts(await readEvidence());
  recordEvidence("password-admission-observations.json", observations);
  return checks + 1;
}
