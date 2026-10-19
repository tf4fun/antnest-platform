import { readDevelopmentConfiguration } from "../../support/development-configuration.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { GatewayClient } from "../identity-closeout/support.mjs";

import { runDevelopmentReplay } from "./private-replay.mjs";

const { values } = parseArgs({ options: { config: { type: "string" } } });
if (!values.config) throw new Error("--config is required");
const { config, settings } = readDevelopmentConfiguration(
  values.config,
  "replay",
);
assert(config.privateAccess, "privateAccess is required");
process.umask(0o077);
mkdirSync(config.output, { recursive: true, mode: 0o700 });
const base = config.gateway;
const admin = new GatewayClient(base);
const sessionId = config.sessionId;
const agentId = config.agentId;
assert.match(sessionId, /^[a-f0-9-]{36}$/);
assert.match(agentId, /^agent_[a-f0-9]+$/);
const sql = (q) =>
  execFileSync(
    "docker",
    [
      "exec",
      config.database.container,
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      config.database.user,
      "-d",
      config.database.name,
      "-c",
      q,
    ],
    { encoding: "utf8", timeout: 15000 },
  ).trim();
assert.deepEqual(
  JSON.parse(
    sql(
      `SELECT jsonb_build_object('agent_id',agent_id,'cwd',cwd) FROM acp_sessions WHERE id='${sessionId}'`,
    ),
  ),
  { agent_id: agentId, cwd: "/workspace" },
  "Session database binding differs from configured Agent",
);
const saved = {
  events: {
    items: JSON.parse(
      sql(
        `SELECT jsonb_agg(jsonb_build_object('visible',visible,'payload',payload) ORDER BY sequence) FROM session_messages WHERE session_id='${sessionId}'`,
      ),
    ),
  },
};
assert(saved.events.items.length > 0);
const decoded = structuredClone(saved);
const files = [];
for (const row of decoded.events.items) {
  const e = row.payload;
  if (e.kind !== "tool_call") continue;
  for (const [encoded, key] of [
    ["argumentsJson", "arguments"],
    ["rawOutputJson", "rawOutput"],
    ["fileJson", "file"],
  ])
    if (e[encoded] !== undefined) e[key] = JSON.parse(e[encoded]);
  if (row.visible) {
    const f = e.file;
    files.push(
      f?.change && f.change.before !== f.change.after
        ? [
            {
              type: "diff",
              path: f.path,
              oldText: f.change.before,
              newText: f.change.after,
            },
          ]
        : [],
    );
  }
  if (e.file) {
    e.locations = [{ path: e.file.path }];
    e.content ??= [];
  }
}
const counts = () =>
  sql(
    "SELECT jsonb_build_array((SELECT count(*) FROM acp_sessions),(SELECT count(*) FROM runs),(SELECT count(*) FROM session_messages),(SELECT count(*) FROM tool_attempts))",
  );
const before = counts();
const login = await admin.request("/api/session/login", {
  body: {
    organization_slug: settings.ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG,
    email: settings.ANTNEST_BOOTSTRAP_ADMIN_EMAIL,
    password: settings.ANTNEST_BOOTSTRAP_ADMIN_PASSWORD,
  },
});
const secrets = [
  ...Object.entries(settings)
    .filter(([k, v]) => /PASSWORD|SECRET|TOKEN|KEY/.test(k) && v?.length > 8)
    .map(([, v]) => v),
  ...admin.cookies.values(),
];
const report = await runDevelopmentReplay(config, {
  browser: admin,
  principal: login.body.principal,
  secrets,
  signal: AbortSignal.timeout(90000),
  decoded,
  files,
  before,
  counts,
});
console.log(JSON.stringify(report));
