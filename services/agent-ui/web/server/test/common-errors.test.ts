import assert from "node:assert/strict";
import { test } from "node:test";
import { error } from "../src/http/command-routes.ts";
import { parseOperationError } from "../src/protocol/agent-view-delta.ts";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

async function read(response: Response) {
  const body = await response.json() as Record<string, unknown>;
  return { status: response.status, headers: response.headers, body };
}

function assertCommon(
  response: Response,
  body: Record<string, unknown>,
  wantStatus: number,
  code: string,
  category: string,
  message: string,
  retryable: boolean,
  recovery: string,
) {
  assert.equal(response.status, wantStatus);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const headerId = response.headers.get("x-request-id");
  assert.ok(headerId && SAFE_ID.test(headerId), "safe x-request-id header");
  for (const key of ["code", "category", "message", "retryable", "request_id"])
    assert.ok(body[key] !== undefined, `missing ${key}`);
  assert.equal(body.code, code);
  assert.equal(body.category, category);
  assert.equal(body.message, message);
  assert.equal(body.retryable, retryable);
  assert.equal(body.request_id, headerId);
  assert.equal(body.requestId, headerId);
  assert.equal(body.recovery, recovery);
  assert.ok(!JSON.stringify(body).includes("private-canary"));
}

test("common_error admission envelope keeps legacy fields", async () => {
  const response = error(400, "invalid_request", "Invalid public input", "none");
  const { body } = await read(response);
  assertCommon(response, body, 400, "invalid_request", "invalid_request", "Invalid public input", false, "none");
});

test("common_error 503 workspace_unavailable keeps retry_read", async () => {
  const response = error(503, "workspace_unavailable", "Workspace is temporarily unavailable", "retry_read");
  const { body } = await read(response);
  assertCommon(response, body, 503, "workspace_unavailable", "unavailable", "Workspace is temporarily unavailable", true, "retry_read");
});

test("common_error 401 keeps login recovery", async () => {
  const response = error(401, "unauthenticated", "Authentication required", "login");
  const { body } = await read(response);
  assertCommon(response, body, 401, "unauthenticated", "unauthenticated", "Authentication required", false, "login");
});

test("common_error unknown code sanitizes to canonical internal", async () => {
  const response = error(500, "ghost_code", "private-canary", "query_operation");
  const { body } = await read(response);
  assertCommon(response, body, 500, "internal", "internal", "Internal service error", false, "none");
  assert.equal(body.details, undefined);
});

test("common_error parser accepts common DTO and rejects mutations", () => {
  const dto = {
    code: "invalid_request",
    category: "invalid_request",
    message: "Invalid public input",
    requestId: "req-1",
    request_id: "req-1",
    retryable: false,
    recovery: "none",
    details: { recovery: "none" },
  };
  assert.ok(parseOperationError(dto) !== undefined, "canonical DTO must parse");
  assert.ok(
    parseOperationError({
      code: "invalid_request",
      message: "Invalid public input",
      requestId: "req-1",
      retryable: false,
      recovery: "none",
    }) !== undefined,
    "legacy DTO still parses",
  );
  for (const mutation of [
    { ...dto, category: "invalid_request" as unknown, ...{ request_id: undefined } },
    (() => { const d = { ...dto }; delete (d as Record<string, unknown>).request_id; return d; })(),
    { ...dto, request_id: "bad id with spaces" },
    { ...dto, request_id: "req-2" },
    { ...dto, cause: "private-canary" },
    { ...dto, details: "not-an-object" },
    (() => { const d = { ...dto }; delete (d as Record<string, unknown>).category; return d; })(),
    { code: "invalid_request", message: "Invalid public input", requestId: "req-1", retryable: false, recovery: "none", category: undefined, request_id: undefined, details: undefined },
    { code: "invalid_request", message: "Invalid public input", requestId: "req-1", retryable: false, recovery: "none", category: undefined },
    { code: "invalid_request", message: "Invalid public input", requestId: "req-1", retryable: false, recovery: "none", request_id: undefined },
    { code: "invalid_request", message: "Invalid public input", requestId: "req-1", retryable: false, recovery: "none", details: undefined },
  ]) {
    assert.equal(parseOperationError(mutation), undefined, `mutation must reject: ${JSON.stringify(mutation).slice(0, 80)}`);
  }
});

test("common_error literal producer codes forbidden", async () => {
  const scan = (source: string): number => {
    let problems = 0;
    for (const token of ["error(", "workspaceFailure("]) {
      let offset = 0;
      for (;;) {
        const position = source.indexOf(token, offset);
        if (position === -1) break;
        const before = position > 0 ? source[position - 1] : "";
        if (/[\w.]/.test(before)) {
          offset = position + token.length;
          continue;
        }
        const rest = source.slice(position + token.length);
        const comma = rest.indexOf(",");
        if (comma >= 0 && rest.slice(comma + 1).trimStart().startsWith('"')) {
          problems++;
        }
        offset = position + token.length;
      }
    }
    return problems;
  };
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("../src/http/", import.meta.url);
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
    const source = readFileSync(new URL(`../src/http/${file}`, import.meta.url), "utf8");
    assert.equal(scan(source), 0, `${file} still has literal producer codes`);
  }
  assert.equal(scan('error(400, "invalid_request", "m", "none")'), 1);
  assert.equal(scan('workspaceFailure(404, "route_not_found")'), 1);
  assert.equal(
    scan("error(\n  400,\n  \"invalid_request\",\n  \"m\",\n  \"none\",\n)"),
    1,
  );
  assert.equal(
    scan("error(400, ERROR_CODES.INVALID_REQUEST, \"m\", \"none\")"),
    0,
  );
});
