import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { RuntimeSkillTemporaryClient } from "../../../../services/agent-acp-service/src/adapters/runtime-skill-temporary-client.js";
import { RuntimeSkillMaintenanceSigner } from "../../../../services/agent-acp-service/src/adapters/runtime-skill-maintenance-signer.js";
import {
  temporaryErrorSchema,
  temporaryInstalledSchema,
  temporaryReleasedSchema,
} from "../../../../services/agent-acp-service/src/domain/temporary-skills.js";
import {
  packageWithFiles,
  packageWithFilesDigest,
} from "../../../../services/agent-acp-service/test/fixtures/skill-discovery-package.js";
import { runtimeAuthority } from "../support/runtime-authority.js";
const schema = JSON.parse(
  readFileSync(
    new URL(
      "../../../../contracts/runtime/temporary-skills.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { $id: string };
const ajv = new Ajv({ strict: true });
ajv.addSchema(schema);
const common = {
  request_id: "request_1",
  job_id: "run_1",
  execution_id: "execution-1",
  effect_state: "settled",
  runtime_call_stopped: true,
};
const digest = `sha256:${"a".repeat(64)}`;
const installed = {
  ...common,
  action: "temporary_install",
  outcome: "installed",
  temporary_path: `/workspace/.antnest/skill-temporary/v1/${"b".repeat(64)}/${"a".repeat(64)}/package`,
  content_digest: digest,
  artifact_digest: digest,
  unpacked_size: 10,
};
describe("ACP consumer of shared Runtime temporary wire contract", () => {
  it("agrees with shared receipt schemas for bounds, unknown fields and effects", () => {
    const error = {
      error: {
        code: "body_timed_out",
        message: "Temporary Skill request did not complete",
        retryable: true,
        effect_state: "none",
        runtime_call_stopped: true,
      },
    };
    const released = {
      ...common,
      action: "temporary_release",
      outcome: "released",
    };
    for (const [name, parser, valid, invalid] of [
      [
        "install_reply",
        temporaryInstalledSchema,
        installed,
        [
          { ...installed, unpacked_size: 33554433 },
          { ...installed, unpacked_size: 0 },
          { ...installed, extra: "x" },
          { ...installed, effect_state: "none" },
          { ...installed, runtime_call_stopped: false },
          { ...installed, temporary_path: "/skills/x" },
        ],
      ],
      [
        "release_reply",
        temporaryReleasedSchema,
        released,
        [
          { ...released, extra: "x" },
          { ...released, outcome: "installed" },
          { ...released, effect_state: "unknown" },
        ],
      ],
      [
        "error_reply",
        temporaryErrorSchema,
        error,
        [
          { error: { ...error.error, code: "new-upstream-error" } },
          { error: { ...error.error, message: "private-body" } },
          { error: { ...error.error, extra: "x" } },
        ],
      ],
    ] as const) {
      const validate = ajv.getSchema(`${schema.$id}#/$defs/${name}`)!;
      expect(validate(valid)).toBe(true);
      expect(parser.safeParse(valid).success).toBe(true);
      for (const value of invalid) {
        expect(validate(value)).toBe(false);
        expect(parser.safeParse(value).success).toBe(false);
      }
    }
  });
  it("signs real HTTP bytes, validates install/release receipts and aborts unfinished reply I/O", async () => {
    const keys = generateKeyPairSync("ed25519"),
      signer = new RuntimeSkillMaintenanceSigner("fixture", keys.privateKey);
    const artifactDigest = `sha256:${createHash("sha256").update(packageWithFiles).digest("hex")}`;
    const loaded = {
      artifact: packageWithFiles,
      contentDigest: packageWithFilesDigest,
      artifactDigest,
      skillText: "guidance",
      requiresRuntimeDelivery: true,
    };
    const installedPath = `/workspace/.antnest/skill-temporary/v1/${"b".repeat(64)}/${packageWithFilesDigest.slice(7)}/package`;
    let hold = false;
    let authority: ReturnType<typeof runtimeAuthority> | undefined;
    const dispatched = Promise.withResolvers<void>(),
      disconnected = Promise.withResolvers<void>(),
      checked: string[] = [];
    const server = createServer((request, response) => {
      if (!authority || !authority.admit(request, response)) return;
      if (request.url === "/status") {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            status: "ready",
            agent_id: authority.configuration.agents[0]!.agent_id,
            execution_id: "execution-1",
          }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const bytes = Buffer.concat(chunks),
          [header, payload, signature] = request.headers
            .authorization!.split(" ")[1]!
            .split(".") as [string, string, string];
        expect(
          verify(
            null,
            Buffer.from(`antnest-skill-maintenance-v1\n${header}.${payload}`),
            keys.publicKey,
            Buffer.from(signature, "base64url"),
          ),
        ).toBe(true);
        const authority = JSON.parse(
          Buffer.from(payload, "base64url").toString(),
        ) as Record<string, unknown>;
        expect(authority.body_sha256).toBe(
          `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        );
        checked.push(request.url!);
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        if (hold) {
          response.flushHeaders();
          response.once("close", () => disconnected.resolve());
          dispatched.resolve();
          return;
        }
        response.end(
          JSON.stringify(
            request.url!.endsWith("install")
              ? {
                  ...installed,
                  request_id: authority.request_id,
                  content_digest: loaded.contentDigest,
                  artifact_digest: artifactDigest,
                  temporary_path: installedPath,
                }
              : {
                  ...common,
                  action: "temporary_release",
                  outcome: "released",
                  request_id: authority.request_id,
                },
          ),
        );
      });
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing fixture port");
      authority = runtimeAuthority(
        new URL(`http://127.0.0.1:${address.port}/mcp`),
      );
      const scope = {
        ...authority.binding,
        organizationId: authority.configuration.organization_id,
        agentId: authority.configuration.agents[0]!.agent_id,
        runId: "run_1",
      };
      const client = new RuntimeSkillTemporaryClient(
        signer,
        authority.connections,
      );
      expect(
        await client.install(scope, loaded, new AbortController().signal),
      ).toEqual({ path: installedPath, unpacked_size: 10 });
      await client.cleanup(scope, new AbortController().signal);
      hold = true;
      const controller = new AbortController(),
        pending = client.install(scope, loaded, controller.signal);
      const rejected = expect(pending).rejects.toMatchObject({
        effectState: "unknown",
        runtimeCallStopped: false,
      });
      await dispatched.promise;
      controller.abort();
      await rejected;
      await disconnected.promise;
      expect(checked).toEqual([
        "/internal/skill-temporary/install",
        "/internal/skill-temporary/release",
        "/internal/skill-temporary/install",
      ]);
    } finally {
      await authority?.connections.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
