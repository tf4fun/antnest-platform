import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { writeGoOverlay } from "../../support/go-overlay.mjs";
import { runCommand } from "../../support/run-command.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const requireAcp = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = requireAcp("ajv/dist/2020.js");

test(
  "configured RC lifecycle output validates against the RuntimeSpec schema",
  { timeout: 180_000 },
  async () => {
    const schema = JSON.parse(
      await readFile(
        resolve(root, "contracts/runtime/runtime-spec.schema.json"),
      ),
    );
    const fixtures = JSON.parse(
      await readFile(
        resolve(root, "contracts/runtime/maintenance-kid-fixtures.json"),
      ),
    );
    const validate = new Ajv2020({
      strict: true,
      validateFormats: false,
    })
      .addSchema(
        JSON.parse(
          await readFile(
            resolve(root, "contracts/runtime/instance-connection.schema.json"),
          ),
        ),
      )
      .compile(schema);
    const output = resolve(
      root,
      `artifacts/verification/maintenance-runtime-spec-${Date.now()}-${process.pid}`,
    );
    const overlay = writeGoOverlay({
      root,
      service: "runtime-controller",
      output,
    });
    const result = await runCommand({
      command: [
        "go",
        "test",
        "-json",
        "-p=1",
        "-count=1",
        "-overlay",
        overlay,
        "-run",
        "^TestGeneratedMaintenanceRuntimeSpecs$",
        "./services/runtime-controller/internal/control",
      ],
      cwd: root,
      output,
      name: "generated-runtime-spec",
      timeoutMs: 150_000,
      graceMs: 10_000,
    });
    assert.equal(
      result.exit_code,
      0,
      `RC component fixture failed; see ${output}`,
    );
    const specs = [];
    for (const line of (
      await readFile(resolve(output, "generated-runtime-spec.log"), "utf8")
    ).split("\n")) {
      if (!line.startsWith("{")) continue;
      const event = JSON.parse(line);
      const marker = "MAINTENANCE_RUNTIME_SPEC:";
      const start = event.Output?.indexOf(marker) ?? -1;
      if (start >= 0)
        specs.push(JSON.parse(event.Output.slice(start + marker.length)));
    }
    assert.equal(
      specs.length,
      fixtures.valid.length + 2,
      "missing generated verifier cases",
    );
    for (const spec of specs)
      assert(validate(spec), JSON.stringify(validate.errors));
    assert.deepEqual(specs[0].skill_maintenance_verifiers.keys, []);
    assert.deepEqual(
      specs[1].skill_maintenance_verifiers.keys.map((key) => key.kid),
      ["key_2026-01", "next_2026-02"],
    );
    assert.deepEqual(
      specs
        .slice(2)
        .map((spec) => spec.skill_maintenance_verifiers.keys[0].kid),
      fixtures.valid,
    );
  },
);
