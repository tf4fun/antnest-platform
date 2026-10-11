import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseArgs, parseEnv } from "node:util";
import {
  GatewayClient,
  assertNoStore,
  assertCookiesCleared,
} from "../identity-closeout/support.mjs";
import { collectTrace } from "./collect.mjs";
import { collectObservabilityResolution } from "./resolve-evidence.mjs";
import {
  requireResolveEvidenceDirectory,
  resolveObservationConfig,
} from "./resolve-config.mjs";
import { inspectLocalAdminLogin } from "./local-admin-login.mjs";
import { durablePath } from "../../support/storage.mjs";
import { gatewaySessionCookies } from "../../support/gateway-session-cookies.mjs";
import { assertClearedSessionCookies } from "../identity-closeout/expiry.mjs";

const requireAcp = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = requireAcp("ajv/dist/2020.js");
const schema = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/edge-gateway/session-response.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const compiler = new Ajv2020({ strict: true });
compiler.addFormat("date-time", {
  type: "string",
  validate(value) {
    const parts =
      /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/u.exec(
        value,
      );
    if (!parts) return false;
    const [year, month, day, hour, minute, second, offsetHour, offsetMinute] =
      parts.slice(1).map((part) => Number(part ?? 0));
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return (
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= days[month - 1] &&
      hour <= 23 &&
      minute <= 59 &&
      second <= 59 &&
      offsetHour <= 23 &&
      offsetMinute <= 59
    );
  },
});
const validSession = compiler.compile({
  $schema: schema.$schema,
  $defs: schema.$defs,
  $ref: "#/$defs/session",
});

function assertSessionMetadata(body) {
  assert(
    validSession(body),
    "response violates the public browser session schema",
  );
  const absolute = Date.parse(body.expires_at);
  const idle = Date.parse(body.idle_expires_at);
  assert(
    typeof body.expires_at === "string" &&
      typeof body.idle_expires_at === "string" &&
      Number.isFinite(absolute) &&
      Number.isFinite(idle) &&
      idle > Date.now() &&
      idle <= absolute,
    "session deadlines must be live and bounded by the absolute expiry",
  );
  assert(
    Number.isInteger(body.activity_interval_ms) &&
      body.activity_interval_ms >= 1 &&
      body.activity_interval_ms <= 30000,
    "invalid browser activity interval",
  );
}

export async function exerciseLocalAdminLogin({
  client,
  settings,
  jaeger,
  secureCookies = true,
  collect = collectTrace,
  collectResolution = collectObservabilityResolution,
  resolveEvidenceDirectory,
  signal,
}) {
  const directory = requireResolveEvidenceDirectory(resolveEvidenceDirectory);
  const config = resolveObservationConfig(settings);
  signal?.throwIfAborted();
  const startedAt = new Date().toISOString();
  const observations = [];
  let originalCookies;
  try {
    const login = await client.request("/api/session/login", {
      body: {
        organization_slug: settings.ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG,
        email: settings.ANTNEST_BOOTSTRAP_ADMIN_EMAIL,
        password: settings.ANTNEST_BOOTSTRAP_ADMIN_PASSWORD,
      },
    });
    originalCookies = new Map(client.cookies);
    signal?.throwIfAborted();
    assertSessionMetadata(login.body);
    assert(
      login.body.principal.active &&
        login.body.principal.system_role === "admin",
      "active system admin required",
    );
    assertNoStore(login.headers);
    const cookies = login.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    const prefix = secureCookies ? "__Host-" : "";
    for (const name of [`${prefix}antnest_session`, `${prefix}antnest_csrf`]) {
      const cookie = cookies.find((value) => value.startsWith(`${name}=`));
      assert(cookie && client.cookies.get(name), "missing session cookie");
      assert(
        /; Path=\/;/iu.test(cookie) &&
          /; SameSite=Lax(?:;|$)/iu.test(cookie) &&
          !/;\s*Domain=/iu.test(cookie),
        "cookie scope mismatch",
      );
      assert.equal(
        /; HttpOnly(?:;|$)/iu.test(cookie),
        name === `${prefix}antnest_session`,
      );
      assert.equal(/; Secure(?:;|$)/iu.test(cookie), secureCookies);
    }
    const restored = await client.request("/api/session", {
      headers: { "X-Antnest-CSRF-Token": "" },
    });
    signal?.throwIfAborted();
    assertSessionMetadata(restored.body);
    for (const field of [
      "expires_at",
      "idle_expires_at",
      "activity_interval_ms",
    ])
      assert(
        restored.body[field] === login.body[field],
        "ordinary session reads must preserve issuance metadata",
      );
    assert(
      JSON.stringify(restored.body.principal) ===
        JSON.stringify(login.body.principal),
      "restored identity differs",
    );
    assert.equal(
      restored.headers.getSetCookie().length,
      0,
      "session read unexpectedly rotated cookies",
    );
    assertNoStore(restored.headers);
    for (const [stage, request] of [
      ["login", login],
      ["session", restored],
    ]) {
      assert.match(request.traceID ?? "", /^[a-f0-9]{32}$/u);
      observations.push(
        stage === "login"
          ? await collect(
              jaeger,
              request.traceID,
              (trace) =>
                inspectLocalAdminLogin(trace, stage, {
                  captureRpcContent: config.captureRpcContent,
                }),
              signal,
            )
          : await collectResolution(
              jaeger,
              {
                traceID: request.traceID,
                profile: "session",
                route: "/api/session",
                method: "GET",
                status: 200,
                resolveTTLMS: config.resolveTTLMS,
              },
              {
                directory,
                signal,
                captureRpcContent: config.captureRpcContent,
                inspect: (trace, expected, collection) =>
                  inspectLocalAdminLogin(trace, stage, {
                    expected,
                    collection,
                  }),
              },
            ),
      );
    }
  } finally {
    if (originalCookies && gatewaySessionCookies(originalCookies).accessToken) {
      client.cookies = new Map(originalCookies);
      const originalCookie = client.cookie;
      const logout = await client.request("/api/session", {
        method: "DELETE",
        status: [204, 401],
      });
      if (logout.status === 401)
        assert(
          logout.body?.code === "unauthenticated",
          "unexpected expired-logout error code",
        );
      assertNoStore(logout.headers);
      assertClearedSessionCookies(logout.headers);
      assertCookiesCleared(client.cookie);
      await client.request("/api/session", {
        status: 401,
        headers: { Cookie: originalCookie },
      });
    }
  }
  return {
    scenario: "BF-AUTH-01",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    independent_cookie_session: true,
    restored_same_principal: true,
    cleanup_revoked: true,
    traces: observations.map((result) => ({
      ...result,
      url: `${jaeger.replace(/\/$/u, "")}/trace/${result.trace_id}`,
    })),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      gateway: { type: "string", default: "http://127.0.0.1:8090" },
      jaeger: { type: "string", default: "http://127.0.0.1:16686" },
      "env-file": { type: "string", default: ".env" },
      "resolve-evidence-directory": { type: "string" },
      "secure-cookies": { type: "boolean", default: true },
      "confirm-development": { type: "boolean", default: false },
    },
  });
  values["env-file"] = durablePath(values["env-file"]);
  const directory = requireResolveEvidenceDirectory(
    values["resolve-evidence-directory"],
  );
  assert(values["confirm-development"], "development confirmation required");
  const result = await exerciseLocalAdminLogin({
    client: new GatewayClient(values.gateway),
    settings: parseEnv(readFileSync(values["env-file"], "utf8")),
    jaeger: values.jaeger,
    secureCookies: values["secure-cookies"],
    resolveEvidenceDirectory: directory,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  await main().catch(() => {
    // Never print error objects from credential-bearing verification.
    console.error(
      "BF-AUTH-01 verification failed; inspect the development instance without dumping credentials.",
    );
    process.exitCode = 1;
  });
}
