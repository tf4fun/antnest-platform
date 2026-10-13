import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { dockerClient } from "../lifecycle-closeout/docker.mjs";
import { until } from "../workspace-closeout/c4-setup.mjs";
import {
  assertIdentityPeers,
  assertWaitChain,
} from "./password-verification-evidence.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const environment = (row) =>
  Object.fromEntries(
    row.Config.Env.map((value) => {
      const at = value.indexOf("=");
      return [value.slice(0, at), value.slice(at + 1)];
    }),
  );

function processIdentity(row) {
  const url = new URL(environment(row).ANTNEST_IDENTITY_DATABASE_URL);
  url.searchParams.delete("application_name");
  return {
    id: row.Id,
    pid: row.State.Pid,
    started_at: row.State.StartedAt,
    image: row.Image,
    database: digest(url.href),
    running: row.State.Running,
    paused: row.State.Paused,
    oom_killed: row.State.OOMKilled,
    restarts: row.RestartCount,
  };
}

function loopback(row, port) {
  const bindings = row.NetworkSettings.Ports[`${port}/tcp`];
  assert.equal(bindings?.length, 1);
  assert.equal(bindings[0].HostIp, "127.0.0.1");
  assert.match(bindings[0].HostPort, /^[1-9][0-9]*$/u);
  return `http://127.0.0.1:${bindings[0].HostPort}`;
}

export async function passwordFixture({ config, docker, compose, signal }) {
  // Loaded only for Docker admission; ordinary evidence unit tests need no DB.
  const { Pool } =
    await import("../../../services/agent-acp-service/node_modules/pg/esm/index.mjs");
  const inspect = async (id, client = docker) =>
    JSON.parse(await client(["inspect", id]))[0];
  const mainID = await docker(compose(["ps", "-q", "identity-service"]));
  const original = await inspect(mainID);
  const owned = (row, service) => {
    assert.equal(
      row.Config.Labels["com.docker.compose.project"],
      config.project,
    );
    assert.equal(row.Config.Labels["com.docker.compose.service"], service);
  };
  owned(original, "identity-service");
  const relay = await inspect(
    await docker(compose(["ps", "-q", "diagnostic-relay"])),
  );
  owned(relay, "diagnostic-relay");
  const postgres = await inspect(
    await docker(compose(["ps", "-q", "postgres"])),
  );
  owned(postgres, "postgres");
  const peerName = `${config.project}-password-peer`;
  assert.equal(
    await docker(["ps", "-aq", "--filter", `name=^/${peerName}$`]),
    "",
  );
  const env = environment(original);
  const dsn = new URL(env.ANTNEST_IDENTITY_DATABASE_URL);
  dsn.searchParams.set("application_name", "issue60-b");
  env.ANTNEST_IDENTITY_DATABASE_URL = dsn.href;
  env.ANTNEST_IDENTITY_LISTEN = "0.0.0.0:8080";
  const networks = Object.keys(original.NetworkSettings.Networks);
  const databaseNetwork = `${config.project}_identity-database`;
  assert(networks.includes(databaseNetwork));
  for (const network of networks) {
    const [row] = JSON.parse(await docker(["network", "inspect", network]));
    assert.equal(row.Labels["com.docker.compose.project"], config.project);
  }
  const args = [
    "create",
    "--name",
    peerName,
    "--label",
    `com.docker.compose.project=${config.project}`,
    "--label",
    "com.docker.compose.service=password-peer",
    "--network",
    databaseNetwork,
    "--network-alias",
    "password-peer",
    "--publish",
    "127.0.0.1::8080",
    "--user",
    original.Config.User,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
  ];
  for (const mount of original.Mounts) {
    assert.equal(mount.Type, "bind");
    assert.equal(mount.RW, false);
    args.push(
      "--mount",
      `type=bind,source=${mount.Source},target=${mount.Destination},readonly`,
    );
  }
  for (const [key, value] of Object.entries(env))
    args.push("--env", `${key}=${value}`);
  args.push(original.Image);
  await docker(args);
  let pool;
  try {
    for (const network of networks.filter((value) => value !== databaseNetwork))
      await docker([
        "network",
        "connect",
        "--alias",
        "password-peer",
        network,
        peerName,
      ]);
    await docker(["start", peerName]);
    const peer = await inspect(peerName);
    owned(peer, "password-peer");
    const endpoints = { a: loopback(original, 8080), b: loopback(peer, 8080) };
    for (const endpoint of Object.values(endpoints))
      await until(
        async () => {
          try {
            const r = await fetch(endpoint + "/status", {
              signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
            });
            await r.arrayBuffer();
            return r.status === 200;
          } catch {
            return false;
          }
        },
        "password Identity process ready",
        signal,
        30000,
      );
    const topology = {
      a: processIdentity(await inspect(mainID)),
      b: processIdentity(await inspect(peerName)),
    };
    assertIdentityPeers(topology.a, topology.b);
    const configuration = Object.fromEntries(
      [
        "MEMORY_KIB",
        "ITERATIONS",
        "PARALLELISM",
        "MEMORY_BUDGET_KIB",
        "MAX_CONCURRENT",
      ].map((key) => [
        key.toLowerCase(),
        Number(env[`ANTNEST_IDENTITY_ARGON2_${key}`]),
      ]),
    );
    configuration.db_pool = Number(dsn.searchParams.get("pool_max_conns"));
    assert.deepEqual(configuration, {
      memory_kib: 65536,
      iterations: 3,
      parallelism: 2,
      memory_budget_kib: 131072,
      max_concurrent: 2,
      db_pool: 64,
    });
    pool = new Pool({
      host: "127.0.0.1",
      port: Number(new URL(loopback(relay, 5432)).port),
      user: "antnest_test_admin",
      password: config.env.ANTNEST_POSTGRES_ADMIN_PASSWORD,
      database: "antnest_identity",
      application_name: "issue60-observer",
      max: 4,
      connectionTimeoutMillis: 3000,
      query_timeout: 4000,
      statement_timeout: 3000,
      idle_in_transaction_session_timeout: 5000,
    });
    const query = async (sql, values = []) => {
      signal.throwIfAborted();
      try {
        return (await pool.query(sql, values)).rows;
      } catch {
        throw new Error("password fixture database query failed");
      }
    };
    const tokens = Object.fromEntries(
      ["edge-gateway", "admin-console"].map((caller) => [
        caller,
        readFileSync(
          join(config.credentials, caller, "tokens", "identity-service"),
          "utf8",
        ),
      ]),
    );
    const requests = [];
    const rpc = async (
      side,
      method,
      body,
      { caller = "edge-gateway", context, status = 200 } = {},
    ) => {
      const traceID = randomBytes(16).toString("hex");
      const response = await fetch(
        `${endpoints[side]}/rpc/identity/${method}`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
          headers: {
            "content-type": "application/json",
            "Antnest-Service-Authorization": `Bearer ${tokens[caller]}`,
            ...(context ? { "Antnest-Caller-Context": context } : {}),
            traceparent: `00-${traceID}-${randomBytes(8).toString("hex")}-01`,
          },
          body: JSON.stringify(body),
        },
      );
      const result = {
        status: response.status,
        headers: response.headers,
        body: await response.json(),
        traceID,
      };
      requests.push({
        side,
        route: `/rpc/identity/${method}`,
        trace_id: traceID,
        status: response.status,
      });
      assert(
        (Array.isArray(status) ? status : [status]).includes(response.status),
        `${side}/${method}: unexpected status ${response.status}`,
      );
      return result;
    };
    const signIn = (side, account, status = 200) =>
      rpc(
        side,
        "local-login",
        { request_id: randomUUID(), ...account },
        { status },
      );
    const context = async (side, token) =>
      (
        await rpc(side, "resolve-access-token", {
          access_token: token,
          profile: "console",
        })
      ).body.caller_context;
    const administer = async (session, method, body) =>
      (
        await rpc(
          "a",
          method,
          {
            request_id: randomUUID(),
            actor_principal_id: session.principal.user_id,
            ...body,
          },
          {
            caller: "admin-console",
            context: await context("a", session.access_token),
          },
        )
      ).body;
    const attempts = async () =>
      query(
        "SELECT scope,encode(key_hash,'hex') AS key,failures,locked_until,window_start FROM credential_attempts ORDER BY scope,key_hash",
      );
    const logs = async (side, client = docker) =>
      (await client(["logs", side === "a" ? mainID : peerName]))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const close = async () => {
      await pool.end();
      const clean = dockerClient(config.env, undefined, 30000);
      const row = await inspect(peerName, clean);
      owned(row, "password-peer");
      await clean(["stop", "-t", "10", peerName]);
      const stopped = await inspect(peerName, clean);
      assert.equal(stopped.State.ExitCode, 0);
      await clean(["rm", peerName]);
    };
    return {
      topology,
      configuration,
      query,
      pool,
      rpc,
      signIn,
      context,
      administer,
      attempts,
      logs,
      requests,
      close,
      process: async () => processIdentity(await inspect(mainID)),
      cpu: async (client = docker) => {
        const c = (await inspect(mainID, client)).HostConfig;
        return {
          period: c.CpuPeriod,
          quota: c.CpuQuota,
          nano_cpus: c.NanoCpus,
        };
      },
      mainID,
      ordered: (options) =>
        orderedRequests({ pool, query, signal, ...options }),
    };
  } catch (error) {
    await pool?.end();
    // Parent cleanup owns the already-labelled clone, including partial startup.
    throw error;
  }
}

async function orderedRequests({
  pool,
  query,
  signal,
  lock,
  values = [],
  first,
  second,
  firstApp = "issue60-a",
  secondApp = "issue60-b",
  firstMarker,
  secondMarker,
}) {
  const client = await pool.connect();
  const jobs = [];
  let chain;
  const launch = (action) => {
    // Attach the rejection handler immediately; finally always joins each HTTP call.
    const job = Promise.resolve()
      .then(action)
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    jobs.push(job);
    return job;
  };
  try {
    await client.query("BEGIN");
    await client.query(lock, values);
    const {
      rows: [{ pid: blocker }],
    } = await client.query("SELECT pg_backend_pid() AS pid");
    const deadline = performance.now() + 1250;
    const wait = async (application, marker, predecessor) => {
      while (true) {
        signal.throwIfAborted();
        const rows = await query(
          "SELECT pid,application_name,state,wait_event_type,query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock'",
          [application],
        );
        const row = rows.find(
          (r) => r.query.includes(marker) && r.blockers.includes(predecessor),
        );
        if (row) return row;
        assert(
          performance.now() < deadline,
          "real Identity lock chain was not observed inside its two-second budget",
        );
        await delay(5, undefined, { signal });
      }
    };
    launch(first);
    const firstWait = await wait(firstApp, firstMarker, blocker);
    launch(second);
    const secondWait = await wait(secondApp, secondMarker, firstWait.pid);
    chain = { blocker, first: firstWait, second: secondWait };
    assertWaitChain(chain, { firstApp, secondApp, firstMarker, secondMarker });
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release(true);
      await Promise.all(jobs);
    }
  }
  const results = await Promise.all(jobs);
  for (const result of results) if (result.error) throw result.error;
  return { chain, responses: results.map((result) => result.value) };
}
