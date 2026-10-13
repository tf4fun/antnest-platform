import assert from "node:assert/strict";
import { request as httpsRequest } from "node:https";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  claimClient,
  releaseClient,
  cancelClient,
} from "./login-admission-process.mjs";

const startPath = "/api/session/oidc/start";
const callbackPath = "/protocol/oidc/callback";

// Keep logical origins separate from the container transport address. TLS
// verifies tls-proxy against the private CA; only Host uses the public origin.
export function routeTarget(value, config) {
  const canonical = new URL(value);
  assert(
    canonical.protocol === "https:" &&
      !canonical.username &&
      !canonical.password,
  );
  const gateway = new URL(config.gateway);
  const issuer = new URL(config.issuer);
  assert([gateway.origin, issuer.origin].includes(canonical.origin));
  const url = new URL(canonical);
  if (canonical.origin === gateway.origin) {
    url.hostname = "tls-proxy";
    url.port = "8443";
  }
  return { url, host: canonical.host };
}

export class CookieJar {
  cookies = new Map();
  constructor(gateway) {
    this.origin = new URL(gateway).origin;
  }
  header(value) {
    if (new URL(value).origin !== this.origin) return "";
    return [...this.cookies]
      .filter(([, cookie]) => cookie.expiresAt > Date.now())
      .map(([name, cookie]) => `${name}=${cookie.value}`)
      .join("; ");
  }
  update(value, rows) {
    assert(new URL(value).origin === this.origin);
    const changes = [];
    for (const raw of rows) {
      const [pair, ...fields] = raw.split(";").map((value) => value.trim());
      const split = pair.indexOf("=");
      assert(split > 0);
      const name = pair.slice(0, split),
        content = pair.slice(split + 1);
      const attrs = new Map(
        fields.map((field) => {
          const index = field.indexOf("=");
          return index < 0
            ? [field.toLowerCase(), ""]
            : [field.slice(0, index).toLowerCase(), field.slice(index + 1)];
        }),
      );
      assert(
        attrs.has("secure") &&
          attrs.get("path") === "/" &&
          !attrs.has("domain"),
      );
      assert.equal(attrs.get("samesite")?.toLowerCase(), "lax");
      if (name.endsWith("_session") || name.endsWith("_oidc"))
        assert(attrs.has("httponly"));
      if (name.endsWith("_csrf")) assert(!attrs.has("httponly"));
      let expiresAt = Infinity;
      if (attrs.has("expires")) {
        expiresAt = Date.parse(attrs.get("expires"));
        assert(Number.isFinite(expiresAt));
      }
      if (attrs.has("max-age")) {
        assert(/^-?\d+$/.test(attrs.get("max-age")));
        expiresAt = Date.now() + Number(attrs.get("max-age")) * 1000;
        assert(Number.isFinite(expiresAt));
      }
      const removed = !content || expiresAt <= Date.now();
      if (removed) this.cookies.delete(name);
      else this.cookies.set(name, { value: content, expiresAt });
      changes.push({ name, removed });
    }
    return changes;
  }
}

function secureTransport(config) {
  return async (canonical, { method, headers, body, onHeaders }) => {
    const target = routeTarget(canonical, config);
    try {
      return await new Promise((resolve, reject) => {
        const request = httpsRequest(
          target.url,
          {
            method,
            headers: { ...headers, Host: target.host },
            servername: target.url.hostname,
            agent: false,
            // NODE_EXTRA_CA_CERTS is the only trust addition in the client image.
            rejectUnauthorized: true,
            signal: AbortSignal.timeout(15000),
          },
          (response) => {
            onHeaders?.({
              status: response.statusCode,
              headers: response.headers,
            });
            let text = "";
            response.setEncoding("utf8");
            response.on("data", (part) => {
              text += part;
              if (text.length > 1024 * 1024)
                request.destroy(new Error("response too large"));
            });
            response.on("error", reject);
            response.on("end", () =>
              resolve({
                status: response.statusCode,
                headers: response.headers,
                text,
              }),
            );
          },
        );
        request.on("error", reject);
        request.end(body);
      });
    } catch {
      throw new Error("login admission HTTPS request failed");
    }
  };
}

function json(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("invalid login admission response JSON");
  }
}

export async function runAdmissionClient(
  config,
  { transport = secureTransport(config), record = () => {} } = {},
) {
  const result = {
    client: config.client,
    action: config.action,
    complete: false,
    receipts: [],
  };
  record(result);
  const jar = new CookieJar(config.gateway);
  const origin = new URL(config.gateway).origin;
  const request = async (path, expected, body) => {
    const url = new URL(path, origin);
    assert.equal(url.origin, origin);
    const method = body === undefined ? "GET" : "POST";
    const before = jar.header(url);
    let receipt;
    result.pending_request = { method, path: url.pathname, trace_id: null };
    record(result);
    const onHeaders = (response) => {
      if (receipt) return;
      const cookies = response.headers["set-cookie"] ?? [];
      const traceID = response.headers["x-antnest-trace-id"];
      const retry = response.headers["retry-after"];
      const noStore = new Set(
        (response.headers["cache-control"] ?? "")
          .toLowerCase()
          .split(",")
          .map((value) => value.trim()),
      );
      // Only bounded, typed fields survive even a malformed response. Never
      // serialize URLs, body text, arbitrary headers, cookie values or exceptions.
      receipt = {
        client: config.client,
        action: config.action,
        sequence: result.receipts.length + 1,
        method,
        path: url.pathname,
        status: response.status,
        trace_id: /^[a-f0-9]{32}$/.test(traceID ?? "") ? traceID : null,
        retry_after: /^[0-9]{1,9}$/.test(retry ?? "") ? Number(retry) : null,
        no_store: noStore.size === 1 && noStore.has("no-store"),
        set_cookie_count: Array.isArray(cookies) ? cookies.length : null,
        cookies_unchanged: false,
        body_complete: false,
      };
      result.receipts.push(receipt);
      delete result.pending_request;
      record(result);
    };
    const response = await transport(url.href, {
      method,
      headers: {
        Origin: origin,
        Cookie: before,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      onHeaders,
    });
    onHeaders(response);
    receipt.body_complete = true;
    record(result);
    const cookies = response.headers["set-cookie"] ?? [];
    assert(Array.isArray(cookies));
    const changes = jar.update(url, cookies);
    receipt.cookies_unchanged = before === jar.header(url);
    record(result);
    assert(receipt.trace_id && receipt.no_store);
    assert.equal(
      response.headers["strict-transport-security"],
      "max-age=31536000",
    );
    assert.equal(response.status, expected);
    if (expected === 429) {
      const payload = json(response.text);
      assert(
        Object.keys(payload).sort().join(",") === "code,message" &&
          payload.code === "login_rate_limited" &&
          payload.message === "Too many login attempts",
      );
      assert.equal(receipt.retry_after, config.retryAfter);
      assert.equal(receipt.set_cookie_count, 0);
      assert(receipt.cookies_unchanged);
    }
    return { ...response, cookieChanges: changes };
  };
  const start = async (status = 200) => {
    const response = await request(startPath, status, {
      organization_slug: "stage3",
      provider_name: config.provider,
    });
    if (status === 200) {
      assert.deepEqual(response.cookieChanges, [
        { name: "__Host-antnest_oidc", removed: false },
      ]);
      assert(jar.cookies.has("__Host-antnest_oidc"));
      assert(
        !jar.cookies.has("__Host-antnest_session") &&
          !jar.cookies.has("__Host-antnest_csrf"),
      );
      const target = new URL(json(response.text).authorization_url);
      routeTarget(target, config);
      assert.equal(
        target.origin + target.pathname,
        config.issuer + "/authorize",
      );
    }
    return response;
  };
  try {
    assert(["a", "b"].includes(config.client));
    assert(
      Number.isSafeInteger(config.sourceLimit) &&
        config.sourceLimit > 0 &&
        config.sourceLimit <= 100,
    );
    assert(Number.isSafeInteger(config.retryAfter) && config.retryAfter > 0);
    if (config.action === "exhaust") {
      for (let n = 0; n < config.sourceLimit; n++) await start();
      await start(429);
    } else if (config.action === "refused") {
      await start(429);
    } else {
      assert.equal(config.action, "login");
      const started = await start();
      const authorization = new URL(json(started.text).authorization_url);
      const issuer = new URL(config.issuer);
      assert.equal(
        authorization.origin + authorization.pathname,
        issuer.href + "/authorize",
      );
      routeTarget(authorization, config);
      assert.equal(
        authorization.searchParams.get("redirect_uri"),
        origin + callbackPath,
      );
      assert.equal(
        authorization.searchParams.get("code_challenge_method"),
        "S256",
      );
      assert(
        authorization.searchParams.get("state") &&
          authorization.searchParams.get("nonce") &&
          authorization.searchParams.get("code_challenge"),
      );
      const authorized = await transport(authorization.href, {
        method: "GET",
        headers: { Cookie: "oidc_fixture_account=opaque" },
      });
      assert.equal(authorized.status, 302);
      const callback = new URL(authorized.headers.location);
      assert.equal(callback.origin + callback.pathname, origin + callbackPath);
      routeTarget(callback, config);
      assert.equal(
        callback.searchParams.get("state"),
        authorization.searchParams.get("state"),
      );
      assert(
        callback.searchParams.get("code") &&
          !callback.searchParams.has("error"),
      );
      const completed = await request(callback, 303);
      assert.equal(completed.headers.location, "/");
      assert.deepEqual(
        completed.cookieChanges.toSorted((a, b) =>
          a.name.localeCompare(b.name),
        ),
        [
          { name: "__Host-antnest_csrf", removed: false },
          { name: "__Host-antnest_oidc", removed: true },
          { name: "__Host-antnest_session", removed: false },
        ],
      );
      assert(!jar.cookies.has("__Host-antnest_oidc"));
      for (const name of ["__Host-antnest_session", "__Host-antnest_csrf"])
        assert(jar.cookies.has(name));
      const session = await request("/api/session", 200);
      assert.equal(result.receipts.at(-1).set_cookie_count, 0);
      const principal = json(session.text).principal;
      for (const [key, value] of Object.entries(config.expectedPrincipal))
        assert(principal?.[key] === value, "unexpected login Principal");
      result.principal = { ...config.expectedPrincipal };
    }
    result.complete = true;
  } catch {
    result.error = "login admission client failed";
  }
  record(result);
  return result;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  let result, owner;
  try {
    if (process.argv[2] === "--cancel") {
      result = await cancelClient();
    } else {
      owner = claimClient();
      result = await runAdmissionClient(
        JSON.parse(process.env.ANTNEST_LOGIN_ADMISSION_CLIENT),
        {
          record: (value) =>
            writeFileSync(
              "/tmp/login-admission-progress.json",
              JSON.stringify(value),
              { mode: 0o600 },
            ),
        },
      );
    }
  } catch {
    result = {
      complete: false,
      receipts: [],
      error: "login admission client failed",
    };
  } finally {
    if (owner) releaseClient("/tmp", owner);
  }
  process.stdout.write(JSON.stringify(result) + "\n");
}
