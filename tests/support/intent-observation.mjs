import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { commonErrorEntry, SAFE_REQUEST_ID } from "./acp-errors.mjs";

const contractsFile = (path) =>
  readFileSync(
    fileURLToPath(new URL(`../../contracts/${path}`, import.meta.url)),
    "utf8",
  );
const catalog = JSON.parse(contractsFile("agent-acp/errors.json"));
const bridgeSchema = JSON.parse(
  contractsFile("agent-acp/workspace-bridge.schema.json"),
);
const OBSERVATION_CODES = new Set(
  bridgeSchema.$defs.observationError.allOf[1].properties.code.enum,
);

export function intentObservationFailure(
  code,
  requestId = "fixture-intent-observation",
) {
  assert(
    OBSERVATION_CODES.has(code),
    `code is not an observationError code: ${code}`,
  );
  const definition = catalog.errors[code];
  assert(definition !== undefined, `code is not in the ACP catalog: ${code}`);
  assert(
    typeof requestId === "string" && SAFE_REQUEST_ID.test(requestId),
    `request_id is unsafe: ${JSON.stringify(requestId)}`,
  );
  const common = commonErrorEntry(code);
  assert.equal(
    definition.http_status,
    common.http_status,
    `http_status drift between catalog and common registry: ${code}`,
  );
  assert.equal(
    definition.retryable,
    common.retryable,
    `retryable drift between catalog and common registry: ${code}`,
  );
  return {
    status: definition.http_status,
    body: {
      code,
      category: common.category,
      message: definition.message,
      retryable: definition.retryable,
      request_id: requestId,
    },
  };
}
