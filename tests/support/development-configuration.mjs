import assert from "node:assert/strict";
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { durablePath, readConfiguration } from "./storage.mjs";

const agentPattern = /^agent_[a-f0-9]{32}$/u;
const sessionPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
function text(value, name, pattern) {
  assert(
    typeof value === "string" && value.length && !value.includes("\0"),
    `${name} is required`,
  );
  if (pattern) assert(pattern.test(value), `invalid ${name}`);
  return value;
}
function object(value, name) {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    `${name} must be an object`,
  );
  return value;
}
function input(path) {
  path = durablePath(path);
  assert(statSync(path).isFile(), "input must be a regular file");
  return readFileSync(path, "utf8");
}
function origin(value, name) {
  const url = new URL(text(value, name));
  assert(
    ["http:", "https:"].includes(url.protocol) &&
      url.hostname &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash,
    `invalid ${name} HTTP origin`,
  );
}
function optionalStat(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
function outputPath(config, name, extension = "json") {
  text(name, "report filename", /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.(?:json|png)$/u);
  assert(name.endsWith(`.${extension}`), "invalid report extension");
  const path = join(durablePath(config.output), name);
  // lstat detects dangling links, which existsSync intentionally does not.
  assert(!optionalStat(path), "report already exists or is a symbolic link");
  return durablePath(path);
}

export function writeDevelopmentJSON(config, name, value) {
  writeFileSync(outputPath(config, name), JSON.stringify(value, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
}

export function writeDevelopmentBuffer(config, name, value) {
  assert(Buffer.isBuffer(value), "screenshot must be a Buffer");
  writeFileSync(outputPath(config, name, "png"), value, {
    flag: "wx",
    mode: 0o600,
  });
}

// Collectors persist intermediate raw Traces while waiting for stable exports.
// Only this writer's own files may be updated; all other reports remain exclusive.
export function createDevelopmentWriter(config, mutableNames = []) {
  const owned = new Map();
  return (name, value) => {
    const previous = owned.get(name);
    if (!previous || !mutableNames.includes(name)) {
      writeDevelopmentJSON(config, name, value);
      if (mutableNames.includes(name))
        owned.set(name, lstatSync(join(config.output, name)));
      return;
    }
    const path = durablePath(join(config.output, name));
    const row = lstatSync(path);
    assert(
      row.isFile() && row.dev === previous.dev && row.ino === previous.ino,
      "owned report was replaced",
    );
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const actual = fstatSync(fd);
      assert(
        actual.isFile() &&
          actual.dev === previous.dev &&
          actual.ino === previous.ino,
        "owned report was replaced",
      );
      ftruncateSync(fd, 0);
      writeFileSync(fd, JSON.stringify(value, null, 2));
    } finally {
      closeSync(fd);
    }
  };
}

export function readDevelopmentConfiguration(file, profile) {
  assert(
    statSync(durablePath(file)).isFile(),
    "configuration must be a regular file",
  );
  const config = object(readConfiguration(file), "configuration");
  const fields = {
    "agent-state": [
      "output",
      "gateway",
      "envFile",
      "agentId",
      "browserReport",
      "reportBasename",
    ],
    "trace-review": [
      "output",
      "jaeger",
      "envFile",
      "secretFile",
      "sessionId",
      "browserReport",
      "expectedTraceCount",
      "minRuntimeTraces",
    ],
    "rejection-trace": [
      "output",
      "jaeger",
      "rejectedSessionId",
      "metadataReport",
    ],
    replay: [
      "output",
      "gateway",
      "jaeger",
      "envFile",
      "agentId",
      "sessionId",
      "browserReport",
      "database",
    ],
    recover: [
      "output",
      "gateway",
      "jaeger",
      "envFile",
      "secretFile",
      "retainedAgentId",
      "runtimeContainerPrefix",
      "runtimeControllerScope",
      "workspaceVolume",
      "workspaceManifest",
    ],
    "runtime-loss": [
      "output",
      "gateway",
      "jaeger",
      "envFile",
      "secretFile",
      "retainedAgentId",
      "fixtureName",
      "workspaceFile",
      "workspaceMarker",
      "restartSnapshot",
      "composeSnapshot",
    ],
    lifecycle: [
      "output",
      "gateway",
      "jaeger",
      "envFile",
      "secretFile",
      "retainedAgentId",
      "fixtureName",
      "workspaceFile",
      "workspaceMarker",
      "runtimeControllerScope",
    ],
  }[profile];
  assert(fields, "unknown development profile");
  assert(
    Object.keys(config).every((key) => fields.includes(key)),
    "unknown configuration field",
  );
  const output = optionalStat(config.output);
  if (output)
    assert(statSync(config.output).isDirectory(), "output must be a directory");
  const previous = config.browserReport
    ? object(JSON.parse(input(config.browserReport)), "browser report")
    : config.metadataReport
      ? object(JSON.parse(input(config.metadataReport)), "metadata report")
      : {};
  let settings = {},
    secrets = {},
    names,
    workspaceManifest,
    publicationCutoff;
  if (profile === "lifecycle" || profile === "runtime-loss") {
    if (profile === "runtime-loss") {
      const compose = object(
        JSON.parse(input(config.composeSnapshot)),
        "Compose snapshot",
      );
      const restart = object(
        JSON.parse(input(config.restartSnapshot)),
        "restart snapshot",
      );
      text(compose.name, "Compose project", /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u);
      config.runtimeControllerScope =
        compose.services?.[
          "runtime-controller"
        ]?.environment?.ANTNEST_RUNTIME_CONTROLLER_SCOPE;
      assert.match(
        restart.Id ?? "",
        /^[a-f0-9]{64}$/u,
        "full Controller ID required",
      );
      assert.equal(
        restart.Name,
        `/${compose.name}-runtime-controller-1`,
        "Controller name mismatch",
      );
      assert.equal(
        restart.Config?.Labels?.["com.docker.compose.project"],
        compose.name,
        "Controller project mismatch",
      );
      assert.equal(
        restart.Config?.Labels?.["com.docker.compose.service"],
        "runtime-controller",
        "Controller service mismatch",
      );
      assert(
        Array.isArray(restart.Config?.Env) &&
          restart.Config.Env.every((x) => typeof x === "string"),
        "Controller environment missing",
      );
      assert.deepEqual(
        restart.Config.Env.filter((x) =>
          x.startsWith("ANTNEST_RUNTIME_CONTROLLER_SCOPE="),
        ),
        [`ANTNEST_RUNTIME_CONTROLLER_SCOPE=${config.runtimeControllerScope}`],
        "Controller scope mismatch",
      );
      const started = restart.State?.StartedAt;
      assert(
        typeof started === "string" &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
            started,
          ),
        "invalid Controller start time",
      );
      publicationCutoff = Date.parse(started) * 1000;
      assert(
        Number.isSafeInteger(publicationCutoff) && publicationCutoff > 0,
        "invalid Controller start time",
      );
    }
    for (const key of ["gateway", "jaeger"]) {
      origin(config[key], key);
      config[key] = new URL(config[key]).origin;
    }
    text(config.retainedAgentId, "retainedAgentId", agentPattern);
    text(
      config.runtimeControllerScope,
      "runtimeControllerScope",
      /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u,
    );
    text(config.fixtureName, "fixtureName");
    assert.equal(
      config.fixtureName.trim(),
      config.fixtureName,
      "fixtureName cannot have boundary whitespace",
    );
    text(config.workspaceFile, "workspaceFile");
    const segments = config.workspaceFile.split("/");
    assert(
      segments.length >= 3 &&
        segments[0] === "" &&
        segments[1] === "workspace" &&
        segments
          .slice(2)
          .every((part) => part && ![".", "..", ".cache"].includes(part)),
      "workspace file must stay inside /workspace outside cache",
    );
    text(config.workspaceMarker, "workspaceMarker");
    assert.equal(
      config.workspaceMarker.trim(),
      config.workspaceMarker,
      "workspace marker cannot have boundary whitespace",
    );
    secrets = parseEnv(input(config.secretFile));
    names = [
      "temporary-agent.json",
      "lifecycle-progress.json",
      "lifecycle-report.json",
      ...["create", "disable", "enable", "rebuild", "delete"].map(
        (kind) => `lifecycle-${kind}.json`,
      ),
    ];
    if (output)
      names.push(
        ...readdirSync(config.output).filter((name) =>
          /^publication-[a-f0-9]{32}\.json$/u.test(name),
        ),
      );
  } else if (profile === "recover") {
    for (const key of ["gateway", "jaeger"]) {
      origin(config[key], key);
      config[key] = new URL(config[key]).origin;
    }
    text(config.retainedAgentId, "retainedAgentId", agentPattern);
    for (const key of [
      "runtimeContainerPrefix",
      "runtimeControllerScope",
      "workspaceVolume",
    ])
      text(config[key], key, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u);
    workspaceManifest = input(config.workspaceManifest);
    assert(
      workspaceManifest === "\n" ||
        /^(?:\\?[a-f0-9]{64} [ *]\.\/[^\0\n]+\n)+$/u.test(workspaceManifest),
      "workspace manifest must contain complete SHA-256 records",
    );
    secrets = parseEnv(input(config.secretFile));
    names = [
      "lifecycle-progress.json",
      "recovered-runtime.json",
      "recovery-trace.private.json",
      "recovery-report.json",
    ];
  } else if (profile === "replay") {
    origin(config.gateway, "gateway");
    origin(config.jaeger, "jaeger");
    config.gateway = new URL(config.gateway).origin;
    config.jaeger = new URL(config.jaeger).origin;
    config.agentId = text(
      config.agentId ?? previous.agent_id,
      "agentId",
      agentPattern,
    );
    config.sessionId = text(
      config.sessionId ?? previous.session_id,
      "sessionId",
      sessionPattern,
    );
    const database = object(config.database, "database");
    assert(
      Object.keys(database).length === 3 &&
        ["container", "user", "name"].every((key) =>
          Object.hasOwn(database, key),
        ),
      "database requires exactly container, user and name",
    );
    text(
      database.container,
      "database.container",
      /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u,
    );
    for (const key of ["user", "name"])
      text(database[key], "database." + key, /^[a-zA-Z_][a-zA-Z0-9_]*$/u);
    names = [
      "replay-updates.private.json",
      "replay-trace.private.json",
      "replay-report.json",
    ];
  } else if (profile === "agent-state") {
    origin(config.gateway, "gateway");
    config.agentId = text(
      config.agentId ?? previous.agent_id,
      "agentId",
      agentPattern,
    );
    config.reportBasename = text(
      config.reportBasename ?? "agent-state",
      "reportBasename",
      /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u,
    );
    names = [config.reportBasename + ".json"];
  } else {
    origin(config.jaeger, "jaeger");
    if (profile === "trace-review") {
      config.sessionId = text(
        config.sessionId ?? previous.session_id,
        "sessionId",
        sessionPattern,
      );
      assert(
        Number.isInteger(config.expectedTraceCount) &&
          config.expectedTraceCount >= 2 &&
          config.expectedTraceCount <= 20,
        "expectedTraceCount must be between two and twenty",
      );
      assert(
        Number.isInteger(config.minRuntimeTraces) &&
          config.minRuntimeTraces >= 2 &&
          config.minRuntimeTraces <= config.expectedTraceCount,
        "minRuntimeTraces must preserve the two-trace minimum",
      );
      names = [
        `traces-${config.expectedTraceCount}.json`,
        `trace-review-${config.expectedTraceCount}.json`,
      ];
      secrets = parseEnv(input(config.secretFile));
    } else {
      config.rejectedSessionId = text(
        config.rejectedSessionId ?? previous.rejected_session_id,
        "rejectedSessionId",
        sessionPattern,
      );
      names = ["rejection-trace.json", "rejection-trace-review.json"];
    }
  }
  if (profile !== "rejection-trace") {
    settings = parseEnv(input(config.envFile));
    const keys = [
      "agent-state",
      "replay",
      "recover",
      "lifecycle",
      "runtime-loss",
    ].includes(profile)
      ? ["ORGANIZATION_SLUG", "ADMIN_EMAIL", "ADMIN_PASSWORD"]
      : ["ADMIN_PASSWORD"];
    for (const key of keys)
      text(settings["ANTNEST_BOOTSTRAP_" + key], "ANTNEST_BOOTSTRAP_" + key);
  }
  for (const name of names)
    outputPath(config, name, name.endsWith(".png") ? "png" : "json");
  return {
    config,
    settings,
    secrets,
    ...(profile === "recover" ? { workspaceManifest } : {}),
    ...(profile === "runtime-loss" ? { publicationCutoff } : {}),
  };
}
