import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { writeGoOverlay } from "../../support/go-overlay.mjs";

const root = new URL("../../../", import.meta.url);
const rootPath = fileURLToPath(root);
const requireFromACP = createRequire(
  new URL("services/agent-acp-service/package.json", root),
);
const Ajv2020 = requireFromACP("ajv/dist/2020.js");

const contractPath = "contracts/runtime/container-security.json";
const shared = JSON.parse(readFileSync(new URL(contractPath, root), "utf8"));
const definitions = shared.resource_properties.definitions;

function resourceSchema(file, defPath) {
  const document = JSON.parse(readFileSync(new URL(file, root), "utf8"));
  let node = document;
  for (const key of defPath) node = node[key];
  return node;
}

const schemaFiles = {
  rc: [
    "services/runtime-controller/api/runtime-deployment.schema.json",
    ["properties", "resources"],
  ],
  ac: [
    "contracts/agent-controller/control-api.schema.json",
    ["$defs", "runtime_resources"],
  ],
  bff_input: [
    "contracts/admin-console/runtime-resources.schema.json",
    ["$defs", "resource_input"],
  ],
  bff_view: [
    "contracts/admin-console/runtime-resources.schema.json",
    ["$defs", "resource_view"],
  ],
};

function compile(file, defPath) {
  const ajv = new Ajv2020({ useDefaults: false, strict: false });
  return ajv.compile({
    $id: "file://" + file,
    ...resourceSchema(file, defPath),
  });
}

test("every service resource schema carries the shared optional limit definitions", () => {
  for (const [name, [file, defPath]] of Object.entries(schemaFiles)) {
    const schema = resourceSchema(file, defPath);
    for (const field of ["cpu_millis", "workspace_bytes"]) {
      const definition = schema.properties[field];
      assert(definition, `${name} missing ${field}`);
      for (const key of ["type", "minimum", "maximum", "default"]) {
        assert.equal(
          definition[key],
          definitions[field][key],
          `${name} ${field}.${key}`,
        );
      }
    }
    assert(
      !schema.required || !schema.required.includes("cpu_millis"),
      `${name} requires cpu_millis`,
    );
    assert(
      !schema.required || !schema.required.includes("workspace_bytes"),
      `${name} requires workspace_bytes`,
    );
    for (const field of ["memory_bytes", "pids_limit", "tmpfs_bytes"]) {
      assert(schema.properties[field], `${name} dropped ${field}`);
    }
  }
});

test("every resource schema rejects null, zero, out-of-range and fractional limits", () => {
  const legacy = {
    memory_bytes: 1073741824,
    pids_limit: 256,
    tmpfs_bytes: 268435456,
  };
  for (const [name, [file, defPath]] of Object.entries(schemaFiles)) {
    const validate = compile(file, defPath);
    for (const field of ["cpu_millis", "workspace_bytes"]) {
      for (const value of [
        0,
        null,
        definitions[field].minimum - 1,
        definitions[field].maximum + 1,
        1.5,
      ]) {
        assert.equal(
          validate({ ...legacy, [field]: value }),
          false,
          `${name} accepted ${field}=${value}`,
        );
      }
    }
    assert.equal(validate({ ...legacy }), true, `${name} rejected omission`);
    assert.equal(
      validate({ ...legacy, cpu_millis: 100, workspace_bytes: 67108864 }),
      true,
      `${name} rejected minimum bounds`,
    );
  }
});

function producerEntries() {
  if (process.env.ANTNEST_RUNTIME_RESOURCE_CAPTURE) {
    return JSON.parse(
      readFileSync(process.env.ANTNEST_RUNTIME_RESOURCE_CAPTURE, "utf8"),
    );
  }
  const run = spawnSync(
    "go",
    [
      "test",
      "-count=1",
      "-run",
      "^TestRuntimeResourceDeliveryProducer$",
      "-v",
      "./services/agent-controller/internal/runtimeclient",
    ],
    {
      cwd: rootPath,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  assert.equal(
    run.status,
    0,
    `producer unit run failed:\n${run.stdout}\n${run.stderr}`,
  );
  assert(
    run.stdout.includes("--- PASS: TestRuntimeResourceDeliveryProducer"),
    run.stdout,
  );
  const marker = run.stdout
    .split("\n")
    .find((line) => line.includes("ANTNEST_RUNTIME_RESOURCE_PAYLOAD="));
  assert(marker, "producer marker missing");
  return JSON.parse(marker.split("ANTNEST_RUNTIME_RESOURCE_PAYLOAD=")[1]);
}

const namedExpectations = {
  legacy: {
    cpu: definitions.cpu_millis.default,
    workspace: definitions.workspace_bytes.default,
  },
  cpu_min: { cpu: 100, workspace: definitions.workspace_bytes.default },
  cpu_default: { cpu: 1000, workspace: definitions.workspace_bytes.default },
  cpu_max: { cpu: 16000, workspace: definitions.workspace_bytes.default },
  workspace_min: { cpu: definitions.cpu_millis.default, workspace: 67108864 },
  workspace_default: {
    cpu: definitions.cpu_millis.default,
    workspace: 10737418240,
  },
  workspace_max: {
    cpu: definitions.cpu_millis.default,
    workspace: 1099511627776,
  },
};

function expectedEffective(entry) {
  const template = entry.template_resources ?? {};
  return {
    cpu: template.cpu_millis ?? definitions.cpu_millis.default,
    workspace: template.workspace_bytes ?? definitions.workspace_bytes.default,
  };
}

test("the actual producer bytes satisfy every consumer resource schema", () => {
  const entries = producerEntries();
  assert.equal(entries.length, 7);
  assert.deepEqual(entries.map((entry) => entry.name).sort(), [
    "cpu_default",
    "cpu_max",
    "cpu_min",
    "legacy",
    "workspace_default",
    "workspace_max",
    "workspace_min",
  ]);
  const rc = compile(...schemaFiles.rc);
  const ac = compile(...schemaFiles.ac);
  const bffInput = compile(...schemaFiles.bff_input);
  const bffView = compile(...schemaFiles.bff_view);
  for (const entry of entries) {
    const named = namedExpectations[entry.name];
    assert(named, `unexpected entry name ${entry.name}`);
    assert.deepEqual(
      expectedEffective(entry),
      named,
      `${entry.name} named coverage`,
    );
    assert.equal(
      entry.configuration.resources.cpu_millis,
      named.cpu,
      `${entry.name} cpu`,
    );
    assert.equal(
      entry.configuration.resources.workspace_bytes,
      named.workspace,
      `${entry.name} workspace`,
    );
    assert(rc(entry.configuration.resources), `${entry.name} fails RC schema`);
    const template = entry.template_resources;
    const before = JSON.parse(JSON.stringify(template));
    assert(ac(template), `${entry.name} fails producer schema`);
    assert(bffInput(template), `${entry.name} fails console input schema`);
    assert(bffView(template), `${entry.name} fails console view schema`);
    assert.deepEqual(
      template,
      before,
      `${entry.name} validation mutated the input`,
    );
  }

  mkdirSync(join(rootPath, "artifacts/verification"), { recursive: true });
  const scratch = mkdtempSync(
    join(rootPath, "artifacts/verification/issue-35-integration-"),
  );
  try {
    const inputFile = join(scratch, "producer-payloads.json");
    writeFileSync(inputFile, JSON.stringify(entries));
    const overlay = writeGoOverlay({
      root: rootPath,
      service: "runtime-controller",
      output: scratch,
      profile: "integration",
    });
    for (const pkg of ["internal/rpc", "internal/platform/docker"]) {
      const run = spawnSync(
        "go",
        [
          "test",
          `-overlay=${overlay}`,
          "-count=1",
          "-run",
          "^TestRuntimeResourceDeliveryConsumer$",
          "-v",
          `./services/runtime-controller/${pkg}`,
        ],
        {
          cwd: rootPath,
          encoding: "utf8",
          timeout: 300_000,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, ANTNEST_RUNTIME_RESOURCE_INPUT: inputFile },
        },
      );
      assert.equal(
        run.status,
        0,
        `${pkg} consumer failed:\n${run.stdout}\n${run.stderr}`,
      );
      assert(
        run.stdout.includes("--- PASS: TestRuntimeResourceDeliveryConsumer"),
        `${pkg} did not run the consumer: ${run.stdout}`,
      );
      assert(
        run.stdout.includes("ANTNEST_RUNTIME_RESOURCE_CONSUMER=7"),
        `${pkg} did not consume all seven entries`,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
