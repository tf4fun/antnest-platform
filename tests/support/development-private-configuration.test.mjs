import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { readDevelopmentConfiguration } from "./development-configuration.mjs";

const agentId = "agent_" + "a".repeat(32);
const sessionId = "11111111-2222-4333-8444-555555555555";
function fixture(t, profile = "agent-state") {
  const root = mkdtempSync(
    join(tmpdir(), "antnest-development-private-config-"),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = (name, value) => {
    const path = join(root, name);
    writeFileSync(path, value, { mode: 0o600 });
    return path;
  };
  const credentials = join(root, "credentials");
  for (const [path, value] of [
    ["edge-gateway/tokens/identity-service", "G"],
    ["agent-ui/tokens/agent-acp-service", "W"],
  ]) {
    mkdirSync(join(credentials, path, ".."), { recursive: true });
    writeFileSync(join(credentials, path), value.repeat(43));
  }
  const config = {
    output: join(root, "out"),
    gateway: "http://127.0.0.1:19000",
    envFile: file(
      "settings.env",
      "ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG=fixture\nANTNEST_BOOTSTRAP_ADMIN_EMAIL=fixture@example.invalid\nANTNEST_BOOTSTRAP_ADMIN_PASSWORD=fixture-password\n",
    ),
    privateAccess: {
      credentials: relative(process.cwd(), credentials),
      acp: "http://127.0.0.1:19001",
      identity: "http://127.0.0.1:19002",
      otlp: "http://127.0.0.1:19003/v1/traces",
    },
  };
  if (["agent-state", "replay"].includes(profile)) config.agentId = agentId;
  if (profile !== "agent-state") config.jaeger = "http://127.0.0.1:16686";
  if (profile === "replay") {
    config.sessionId = sessionId;
    config.database = {
      container: "fixture-db",
      user: "fixture",
      name: "fixture",
    };
  }
  if (["recover", "runtime-loss"].includes(profile)) {
    config.retainedAgentId = agentId;
    config.secretFile = file("secret.env", "API_KEY=fixture-secret\n");
  }
  if (profile === "recover") {
    config.runtimeContainerPrefix = "fixture-runtime-";
    config.runtimeControllerScope = "fixture-scope";
    config.workspaceVolume = "fixture-workspace";
    config.workspaceManifest = file("workspace.sha256", "\n");
  }
  if (profile === "runtime-loss") {
    config.fixtureName = "temporary fixture";
    config.workspaceFile = "/workspace/marker";
    config.workspaceMarker = "fixture marker";
    config.composeSnapshot = file(
      "compose.json",
      JSON.stringify({
        name: "fixture",
        services: {
          "runtime-controller": {
            environment: {
              ANTNEST_RUNTIME_CONTROLLER_SCOPE: "fixture-scope",
            },
          },
        },
      }),
    );
    config.restartSnapshot = file(
      "restart.json",
      JSON.stringify({
        Id: "a".repeat(64),
        Name: "/fixture-runtime-controller-1",
        State: { StartedAt: "2026-10-19T00:00:00Z" },
        Config: {
          Labels: {
            "com.docker.compose.project": "fixture",
            "com.docker.compose.service": "runtime-controller",
          },
          Env: ["ANTNEST_RUNTIME_CONTROLLER_SCOPE=fixture-scope"],
        },
      }),
    );
  }
  return {
    root,
    config,
    credentials,
    read() {
      return readDevelopmentConfiguration(
        file("config.json", JSON.stringify(config)),
        profile,
      );
    },
  };
}

for (const profile of ["agent-state", "replay", "recover", "runtime-loss"])
  test(`${profile} preflights explicit private endpoints and original workload grant files`, (t) => {
    const f = fixture(t, profile);
    const loaded = f.read();
    assert.deepEqual(loaded.config.privateAccess, {
      ...f.config.privateAccess,
      credentials: f.credentials,
    });
  });

for (const alias of [false, true])
  test(`replay rejects an existing ${alias ? "aliased" : "ordinary"} Trace directory before effects`, (t) => {
    const f = fixture(t, "replay");
    mkdirSync(f.config.output);
    const path = join(f.config.output, "traces");
    if (alias) symlinkSync(join(f.root, ".cache", "traces"), path);
    else mkdirSync(path);
    assert.throws(() => f.read(), /replay trace directory/);
  });

for (const [name, change] of [
  [
    "unknown option",
    (p) => {
      p.token = "invented";
    },
  ],
  [
    "missing endpoint",
    (p) => {
      delete p.identity;
    },
  ],
  [
    "external endpoint",
    (p) => {
      p.acp = "http://example.invalid:19001";
    },
  ],
  [
    "implicit port",
    (p) => {
      p.identity = "http://127.0.0.1";
    },
  ],
  [
    "endpoint path",
    (p) => {
      p.acp += "/v1/acp";
    },
  ],
  [
    "endpoint credentials",
    (p) => {
      p.acp = "http://user:secret@127.0.0.1:19001";
    },
  ],
  [
    "endpoint query",
    (p) => {
      p.identity += "?key=value";
    },
  ],
  [
    "wrong OTLP path",
    (p) => {
      p.otlp = "http://127.0.0.1:19003/";
    },
  ],
  [
    "OTLP fragment",
    (p) => {
      p.otlp += "#fragment";
    },
  ],
])
  test(`private configuration rejects ${name} before driver effects`, (t) => {
    const f = fixture(t);
    // Establish a valid baseline so rejection cannot pass on an unknown top-level field.
    f.read();
    change(f.config.privateAccess);
    assert.throws(() => f.read(), /privateAccess/);
  });

for (const [name, change] of [
  [
    "missing grant",
    (f) => rmSync(join(f.credentials, "edge-gateway/tokens/identity-service")),
  ],
  [
    "invalid grant",
    (f) =>
      writeFileSync(
        join(f.credentials, "agent-ui/tokens/agent-acp-service"),
        "wrong",
      ),
  ],
  [
    "directory grant",
    (f) => {
      const path = join(f.credentials, "agent-ui/tokens/agent-acp-service");
      rmSync(path);
      mkdirSync(path);
    },
  ],
  [
    "cached credential root",
    (f) => {
      f.config.privateAccess.credentials = join(
        f.root,
        ".cache",
        "credentials",
      );
    },
  ],
])
  test(`private configuration rejects ${name} in preflight`, (t) => {
    const f = fixture(t);
    f.read();
    change(f);
    assert.throws(() => f.read());
  });

test("private configuration reserves the authority and state evidence before login", (t) => {
  const f = fixture(t);
  f.read();
  mkdirSync(f.config.output);
  writeFileSync(
    join(f.config.output, "private-access.private.json"),
    "original evidence",
  );
  assert.throws(() => f.read(), /exist/);
});
