import {
  createHash,
  createPrivateKey,
  createPublicKey,
  verify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  RuntimeSkillMaintenanceSigner,
  type SkillMaintenanceAction,
} from "../../../../services/agent-acp-service/src/adapters/runtime-skill-maintenance-signer.js";

interface SharedGoldenHelpers {
  assertGolden: (
    path: URL,
    actual: unknown,
    options?: { update?: boolean },
  ) => void;
}

const { assertGolden } = (await import(
  new URL("../../../support/contracts/golden.mjs", import.meta.url).href
)) as SharedGoldenHelpers;

const ticketContract = JSON.parse(
  readFileSync(
    new URL(
      "../../../../contracts/runtime/maintenance-ticket.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as object;
const commonIDs = JSON.parse(
  readFileSync(
    new URL("../../../../contracts/common/ids.schema.json", import.meta.url),
    "utf8",
  ),
) as object;
const vectors = (
  JSON.parse(
    readFileSync(
      new URL(
        "../../../../contracts/runtime/maintenance-ticket-fixtures.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { valid: { action: SkillMaintenanceAction; generation: number }[] }
).valid;
const ticketValidator = new Ajv2020({ strict: true, validateFormats: false });
ticketValidator.addSchema(commonIDs);
const validateTicket = ticketValidator.compile(ticketContract);

const privateKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.alloc(32, 7),
  ]),
  format: "der",
  type: "pkcs8",
});
const publicKey = createPublicKey(privateKey);

describe("Runtime Skill maintenance ticket captures", () => {
  it("records the real ACP signer output for every shared valid vector", () => {
    const signer = new RuntimeSkillMaintenanceSigner(
      "key-1",
      privateKey,
      () => 1_790_000_000,
    );
    const tickets = vectors.map((vector) => {
      const jobId = vector.action.startsWith("temporary_") ? "run-1" : "job-1";
      const body = Buffer.from(
        JSON.stringify({
          action: vector.action,
          request_id: "request-1",
          job_id: jobId,
          generation: vector.generation,
        }),
      );
      const authorization = signer.sign({
        organizationId: "org-1",
        agentId: "agent-1",
        executionId: "execution-1",
        jobId,
        generation: vector.generation,
        action: vector.action,
        requestId: "request-1",
        body,
      });
      const [header, payload, signature] = authorization
        .slice("AntnestMaintenance ".length)
        .split(".");
      const decoded = JSON.parse(
        Buffer.from(payload!, "base64url").toString(),
      ) as Record<string, unknown>;
      expect(validateTicket(decoded)).toBe(true);
      expect(decoded).toMatchObject({
        organization_id: "org-1",
        agent_id: "agent-1",
        execution_id: "execution-1",
        job_id: jobId,
        generation: vector.generation,
        action: vector.action,
        request_id: "request-1",
        body_sha256: `sha256:${createHash("sha256").update(body).digest("hex")}`,
      });
      expect(
        verify(
          null,
          Buffer.from(`antnest-skill-maintenance-v1\n${header}.${payload}`),
          publicKey,
          Buffer.from(signature!, "base64url"),
        ),
      ).toBe(true);
      return {
        action: vector.action,
        generation: vector.generation,
        body_base64url: body.toString("base64url"),
        authorization,
      };
    });
    expect(
      tickets.map(({ action, generation }) => ({ action, generation })),
    ).toEqual(
      vectors.map(({ action, generation }) => ({ action, generation })),
    );
    assertGolden(
      new URL(
        "../../skill-learning/maintenance-ticket-captures.json",
        import.meta.url,
      ),
      {
        public_key_base64url: publicKey
          .export({ format: "der", type: "spki" })
          .subarray(-32)
          .toString("base64url"),
        now_epoch: 1_790_000_030,
        execution_id: "execution-1",
        agent_id: "agent-1",
        tickets,
      },
      { update: process.env.UPDATE_GOLDEN === "1" },
    );
  });
});
