import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A grant names one sender credential for one receiver, as provisioned by
// scripts/dev-service-tokens.mjs under <credentials>/<sender>/tokens/<receiver>.
export const grants = {
  "gateway-identity": ["edge-gateway", "identity-service"],
  "acp-controller": ["agent-acp-service", "agent-controller"],
  "console-controller": ["admin-console", "agent-controller"],
  "acp-registry": ["agent-acp-service", "skill-registry"],
  "console-registry": ["admin-console", "skill-registry"],
  "controller-runtime": ["agent-controller", "runtime-controller"],
};
const receiverNetworks = {
  "identity-service": "identity-clients",
  "agent-controller": "controller-clients",
  "skill-registry": "registry-clients",
  "runtime-controller": "controller-runtime",
};
const endpoints = {
  "identity-service": "http://identity-service:8080",
};

// Test clients join each receiver's private network and read the disposable
// credential from a read-only mount as the service-auth user.
export function grantContainerArgs(config, wanted = []) {
  const networks = [];
  const args = [];
  for (const grant of wanted) {
    assert(Object.hasOwn(grants, grant), `unknown client grant ${grant}`);
    const [sender, receiver] = grants[grant];
    const network = receiverNetworks[receiver];
    if (!networks.includes(network)) networks.push(network);
    args.push(
      "-v",
      `${join(config.credentials, sender, "tokens", receiver)}:/run/auth/${grant}:ro`,
    );
  }
  if (args.length)
    args.unshift(
      "--user",
      `${config.env.ANTNEST_SERVICE_AUTH_UID}:${config.env.ANTNEST_SERVICE_AUTH_GID}`,
    );
  return { networks, args };
}

export function serviceClient({
  fetch = globalThis.fetch,
  readCredential = (grant) => readFileSync(`/run/auth/${grant}`, "utf8"),
} = {}) {
  const credential = (grant) => {
    const value = readCredential(grant);
    assert(
      /^[A-Za-z0-9_-]{43}$/u.test(value),
      "invalid disposable credential encoding",
    );
    return value;
  };
  async function send(
    url,
    grant,
    { method = "POST", body, form, context, headers = {} } = {},
  ) {
    return fetch(url, {
      method,
      redirect: "manual",
      headers: {
        "Antnest-Service-Authorization": `Bearer ${credential(grant)}`,
        ...(context ? { "Antnest-Caller-Context": context } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal: AbortSignal.timeout(12000),
    });
  }
  // Failures carry the path, status and error code only; never credentials.
  async function json(url, grant, { status = 200, ...options } = {}) {
    const response = await send(url, grant, options);
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {}
    if (response.status !== status) {
      const code = parsed?.code ?? parsed?.error?.code;
      throw new Error(
        `${new URL(url).pathname}: HTTP ${response.status} ${code ?? "unknown"}`,
      );
    }
    return parsed;
  }
  // Identity issues a Console caller context the way edge-gateway does for a
  // signed-in user; agentId scopes it to one Agent.
  async function callerContext(account, agentId) {
    const identity = endpoints["identity-service"];
    const session = await json(
      `${identity}/rpc/identity/local-login`,
      "gateway-identity",
      { body: { request_id: randomUUID(), ...account } },
    );
    const issued = await json(
      `${identity}/rpc/identity/resolve-access-token`,
      "gateway-identity",
      {
        body: {
          access_token: session.access_token,
          profile: "console",
          ...(agentId === undefined ? {} : { agent_id: agentId }),
        },
      },
    );
    return { context: issued.caller_context, principal: session.principal };
  }
  return { send, json, callerContext };
}
