import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const root = new URL("../../../", import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const schemaPath = "contracts/agent-acp/owner-incarnation-history.schema.json";
const manifestPath =
  "contracts/agent-acp/owner-incarnation-history-contract.json";
const schemaID =
  "https://antnest.dev/contracts/agent-acp/owner-incarnation-history.schema.json";
const routePath = "/internal/acp-incarnations/history";
const historyID = "01234567-89ab-4cde-8fab-0123456789ab";
const otherHistoryID = "23456789-abcd-4ef0-abcd-23456789abcd";
const registration = () => ({
  registration_id: "12345678-9abc-4def-9abc-123456789abc",
  member_id: "acp-a",
  incarnation_id: "34567890-bcde-4f01-9012-34567890abcd",
});
const cursor = () => ({
  history_id: historyID,
  snapshot_revision: "3",
  after_sequence: "2",
});
const entry = () => ({ sequence: "1", registration: registration() });
const request = () => ({ member_id: "acp-a", cursor: null });
const response = () => ({
  member_id: "acp-a",
  history_id: historyID,
  snapshot_revision: "3",
  after_sequence: "0",
  items: [entry()],
  next_cursor: cursor(),
});
const objectCases = [
  { definition: "request", make: request, wrap: (value) => value },
  { definition: "cursor", make: cursor, wrap: (value) => value },
  { definition: "registration_entry", make: entry, wrap: (value) => value },
  {
    definition: "registration_entry",
    make: registration,
    wrap: (value) => ({ ...entry(), registration: value }),
  },
  { definition: "response", make: response, wrap: (value) => value },
];
function validators() {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    validateFormats: false,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  ajv.addSchema(read("contracts/agent-acp/owner-incarnation.schema.json"));
  ajv.addSchema(read(schemaPath));
  return Object.fromEntries(
    ["request", "cursor", "registration_entry", "response"].map((name) => [
      name,
      ajv.compile({ $ref: `${schemaID}#/$defs/${name}` }),
    ]),
  );
}
function check(v, definition, value, expected, label) {
  const original = structuredClone(value);
  assert.equal(
    v[definition](value),
    expected,
    `${label}: ${JSON.stringify(v[definition].errors)}`,
  );
  assert.deepEqual(
    value,
    original,
    `${label}: validation must not mutate input`,
  );
}

test("history has its own schema and accepts independent empty, first and continuation wire examples", () => {
  assert.equal(read(schemaPath).$id, schemaID);
  const v = validators();
  check(v, "request", request(), true, "first request");
  check(
    v,
    "request",
    { member_id: "acp-a", cursor: cursor() },
    true,
    "continuation request",
  );
  check(
    v,
    "response",
    {
      member_id: "acp-a",
      history_id: historyID,
      snapshot_revision: "0",
      after_sequence: "0",
      items: [],
      next_cursor: null,
    },
    true,
    "empty history",
  );
  check(
    v,
    "response",
    {
      member_id: "acp-a",
      history_id: historyID,
      snapshot_revision: "3",
      after_sequence: "0",
      items: [
        entry(),
        {
          sequence: "2",
          registration: { ...registration(), registration_id: otherHistoryID },
        },
      ],
      next_cursor: cursor(),
    },
    true,
    "first page",
  );
  check(
    v,
    "response",
    {
      member_id: "acp-a",
      history_id: historyID,
      snapshot_revision: "3",
      after_sequence: "2",
      items: [{ sequence: "3", registration: registration() }],
      next_cursor: null,
    },
    true,
    "continuation page",
  );
});

test("all history objects require every field and reject wrong object and field types", () => {
  const v = validators();
  for (const { definition, make, wrap } of objectCases) {
    for (const invalid of [null, false, 1, "object", []])
      check(
        v,
        definition,
        wrap(invalid),
        false,
        `${definition}: object required`,
      );
    for (const field of Object.keys(make())) {
      const missing = make();
      delete missing[field];
      check(
        v,
        definition,
        wrap(missing),
        false,
        `${definition}: missing ${field}`,
      );
      const original = make()[field];
      const invalidTypes =
        typeof original === "string"
          ? [null, false, 1, {}, []]
          : Array.isArray(original)
            ? [null, false, 1, "wrong", {}]
            : [false, 1, "wrong", []];
      for (const invalid of invalidTypes)
        check(
          v,
          definition,
          wrap({ ...make(), [field]: invalid }),
          false,
          `${definition}: invalid ${field}`,
        );
    }
  }
});

test("closed history objects reject aliases and private scope, selector, container, nonce and stop authority", () => {
  const v = validators();
  const privateFields = {
    scope: "caller-selected-controller",
    selector: "container-name",
    container: "private-container",
    docker_engine_id: "private-engine",
    registration_nonce: "a".repeat(64),
    nonce: "b".repeat(64),
    stop_proof: true,
    stop_receipt: { receipt_id: otherHistoryID },
    quiescent: true,
    epoch: "7",
    caller_context: "private-context",
  };
  for (const { definition, make, wrap } of objectCases) {
    for (const [field, value] of Object.entries(privateFields))
      check(
        v,
        definition,
        wrap({ ...make(), [field]: value }),
        false,
        `${definition}: rejects ${field}`,
      );
    for (const field of Object.keys(make()))
      check(
        v,
        definition,
        wrap({ ...make(), [field.toUpperCase()]: make()[field] }),
        false,
        `${definition}: alias ${field}`,
      );
  }
});

test("cursor snapshots and registration sequences use positive canonical decimal strings", () => {
  const v = validators();
  for (const [definition, make, field] of [
    ["cursor", cursor, "snapshot_revision"],
    ["registration_entry", entry, "sequence"],
  ]) {
    for (const value of [
      "1",
      "9",
      "9223372036854775807",
      "9999999999999999999",
    ])
      check(
        v,
        definition,
        { ...make(), [field]: value },
        true,
        `${field}: valid lexical form`,
      );
    for (const value of [
      "0",
      "",
      "00",
      "01",
      "+1",
      "-1",
      "1.0",
      "1e2",
      "1E2",
      "0x1",
      " 1",
      "1 ",
      "1".repeat(20),
      "１",
      "1\n",
      "1\r",
      "1\r\n",
      "1\u2028",
      "1\u2029",
      1,
      null,
    ])
      check(
        v,
        definition,
        { ...make(), [field]: value },
        false,
        `${field}: invalid decimal`,
      );
  }
});

test("response snapshots and page positions allow canonical zero without numeric coercion", () => {
  const v = validators();
  for (const [definition, make, field] of [
    ["cursor", cursor, "after_sequence"],
    ["response", response, "snapshot_revision"],
    ["response", response, "after_sequence"],
  ]) {
    for (const value of [
      "0",
      "1",
      "9223372036854775807",
      "9999999999999999999",
    ])
      check(
        v,
        definition,
        { ...make(), [field]: value },
        true,
        `${field}: nonnegative lexical form`,
      );
    for (const value of [
      "",
      "00",
      "01",
      "+0",
      "-0",
      "-1",
      "1.0",
      "1e1",
      " 0",
      "0 ",
      "1".repeat(20),
      "0\n",
      "0\r",
      "0\r\n",
      "0\u2028",
      "0\u2029",
      0,
      null,
    ])
      check(
        v,
        definition,
        { ...make(), [field]: value },
        false,
        `${field}: invalid decimal`,
      );
  }
});

test("history and original registration identities retain strict UUIDv4 and member bounds", () => {
  const v = validators();
  const identities = [
    ["cursor", cursor, "history_id", (value) => value],
    ["response", response, "history_id", (value) => value],
    [
      "registration_entry",
      registration,
      "registration_id",
      (value) => ({ ...entry(), registration: value }),
    ],
    [
      "registration_entry",
      registration,
      "incarnation_id",
      (value) => ({ ...entry(), registration: value }),
    ],
  ];
  for (const [definition, make, field, wrap] of identities) {
    for (const value of [historyID, otherHistoryID])
      check(
        v,
        definition,
        wrap({ ...make(), [field]: value }),
        true,
        `${field}: UUIDv4`,
      );
    for (const value of [
      "",
      historyID.toUpperCase(),
      historyID.replace("-4cde-", "-1cde-"),
      historyID.replace("-8fab-", "-cfab-"),
      historyID.replaceAll("-", ""),
      ` ${historyID}`,
      `${historyID} `,
      ...["\n", "\r", "\r\n", "\u2028", "\u2029"].map(
        (suffix) => historyID + suffix,
      ),
      null,
      1,
    ])
      check(
        v,
        definition,
        wrap({ ...make(), [field]: value }),
        false,
        `${field}: invalid identity`,
      );
  }
  for (const [definition, make, wrap] of [
    ["request", request, (value) => value],
    ["response", response, (value) => value],
    [
      "registration_entry",
      registration,
      (value) => ({ ...entry(), registration: value }),
    ],
  ]) {
    for (const member_id of ["a", "0", "acp-a", "a".repeat(64)])
      check(
        v,
        definition,
        wrap({ ...make(), member_id }),
        true,
        "member boundary",
      );
    for (const member_id of [
      "",
      "a".repeat(65),
      "ACP-a",
      "acp.a",
      "-acp",
      "acp-",
      " acp-a",
      "acp-a ",
      ...["\n", "\r", "\r\n", "\u2028", "\u2029"].map(
        (suffix) => "acp-a" + suffix,
      ),
      null,
      1,
    ])
      check(
        v,
        definition,
        wrap({ ...make(), member_id }),
        false,
        "invalid member",
      );
  }
});

test("first and terminal cursors are explicit null while continuation cursors are complete closed objects", () => {
  const v = validators();
  for (const value of [null, cursor()]) {
    check(
      v,
      "request",
      { ...request(), cursor: value },
      true,
      "request cursor",
    );
    check(
      v,
      "response",
      { ...response(), next_cursor: value },
      true,
      "response cursor",
    );
  }
  for (const value of [
    "opaque-string",
    false,
    1,
    [],
    {},
    { ...cursor(), scope: "other" },
    { ...cursor(), snapshot_revision: "0" },
  ]) {
    check(
      v,
      "request",
      { ...request(), cursor: value },
      false,
      "invalid request cursor",
    );
    check(
      v,
      "response",
      { ...response(), next_cursor: value },
      false,
      "invalid response cursor",
    );
  }
});

test("history pages allow zero through sixty-four complete registration entries and reject a sixty-fifth", () => {
  const v = validators();
  const entries = Array.from({ length: 65 }, (_, index) => ({
    sequence: String(index + 1),
    registration: {
      ...registration(),
      registration_id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    },
  }));
  for (const count of [0, 1, 64])
    check(
      v,
      "response",
      { ...response(), items: entries.slice(0, count) },
      true,
      `page of ${count}`,
    );
  check(
    v,
    "response",
    { ...response(), items: entries },
    false,
    "oversized page",
  );
});

test("wire grammar leaves signed-bigint range, contiguous sequence and cursor echo checks to producer and consumer", () => {
  const v = validators();
  // Shape-positive examples are not valid operational pages: RC/ACP acceptance
  // must check BigInt <= 9223372036854775807, membership/scope, echoes and order.
  check(
    v,
    "cursor",
    { ...cursor(), snapshot_revision: "9223372036854775808" },
    true,
    "range is semantic",
  );
  check(
    v,
    "response",
    {
      ...response(),
      snapshot_revision: "1",
      after_sequence: "9",
      items: [{ ...entry(), sequence: "3" }, entry()],
      next_cursor: { ...cursor(), history_id: otherHistoryID },
    },
    true,
    "cross-field checks are semantic",
  );
});

test("the implemented manifest freezes the history operation, page size and non-authority semantics", () => {
  const manifest = read(manifestPath);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.status, "implemented");
  assert.equal(manifest.issue, 49);
  assert.equal(manifest.schema, "owner-incarnation-history.schema.json");
  assert.deepEqual(Object.keys(manifest.operations), ["history"]);
  for (const [key, value] of Object.entries({
    method: "POST",
    path: routePath,
    receiver: "runtime-controller",
    callers: ["agent-acp-service"],
    authentication: "workload",
    caller_context: "none",
    request: "request",
    response: "response",
    request_bytes_max: 4096,
    response_bytes_max: 32768,
    deadline_ms: 10000,
    cache_control: "no-store",
    capture_payload: false,
    query_parameters: [],
  }))
    assert.deepEqual(manifest.operations.history[key], value, `history.${key}`);
  for (const [key, value] of Object.entries({
    page_size: 64,
    scope_source: "configured-controller-scope",
    immutable_snapshot: true,
    existing_registrations: "required",
  }))
    assert.deepEqual(manifest.pagination[key], value, `pagination.${key}`);
  assert.equal(manifest.authority.history_is_stop_proof, false);
  assert.equal(manifest.authority.history_is_admission_barrier, false);
});

test("the implemented history route has exact RC grants, revision 21 aliases and manifest limits", () => {
  const manifest = read(manifestPath);
  assert.equal(manifest.status, "implemented");
  const callers = read("services/runtime-controller/api/callers.json");
  assert.deepEqual(
    Object.keys(callers.routes)
      .filter((route) => route.endsWith(` ${routePath}`))
      .sort(),
    [`* ${routePath}`, `POST ${routePath}`],
  );
  assert.deepEqual(callers.routes[`POST ${routePath}`], {
    callers: ["agent-acp-service"],
    authentication: "workload",
    caller_context: { "agent-acp-service": "none" },
    request_body: "json",
  });
  assert.deepEqual(callers.routes[`* ${routePath}`], {
    callers: [],
    authentication: "deny",
    caller_context: {},
    request_body: "none",
  });
  const contract = read(
    "services/runtime-controller/api/control-contract.json",
  );
  assert.equal(contract.revision, 21);
  const matches = contract.routes.filter((route) => route.path === routePath);
  assert.equal(matches.length, 1);
  const [route] = matches;
  assert.equal(route.method, "POST");
  assert.equal(route.operation_id, "historyAcpIncarnations");
  assert.deepEqual(route.required_headers, ["Antnest-Service-Authorization"]);
  assert.equal(
    route.request_body,
    "control-api.schema.json#/$defs/acp_history_request",
  );
  assert.deepEqual(route.responses, {
    200: {
      content_type: "application/json",
      body: "control-api.schema.json#/$defs/acp_history_page",
    },
  });
  const wire = manifest.operations.history;
  assert.equal(route.path, wire.path);
  assert.equal(route.method, wire.method);
  for (const field of [
    "request_bytes_max",
    "response_bytes_max",
    "deadline_ms",
    "cache_control",
    "capture_payload",
  ])
    assert.equal(route[field], wire[field], `history.${field}`);
  assert.deepEqual(
    Object.keys(route.query_parameters ?? {}),
    wire.query_parameters,
  );
  assert.deepEqual(Object.keys(route.path_parameters ?? {}), []);
  assert.deepEqual([...route.errors].sort(), [...wire.errors].sort());
  const schema = read(
    "services/runtime-controller/api/control-api.schema.json",
  );
  for (const [alias, definition] of [
    ["acp_history_request", "request"],
    ["acp_history_page", "response"],
  ])
    assert.deepEqual(schema.$defs[alias], {
      $ref: `${schemaID}#/$defs/${definition}`,
    });
});

test("history documentation requires existing-registration migration, original inspection and a separate participation barrier", () => {
  const document = readFileSync(
    new URL("contracts/agent-acp/owner-handoff.md", root),
    "utf8",
  );
  const history = document
    .split(/\n\s*\n/u)
    .filter((part) => /histor(?:y|ies|ical)/iu.test(part))
    .join("\n");
  assert.ok(
    history.length > 0,
    "history discovery semantics must be documented",
  );
  assert.match(history, /registr/iu);
  assert.match(history, /existing|already|migrat|backfill/iu);
  assert.match(history, /all|every|complete|includ/iu);
  assert.match(
    history,
    /InspectAcpIncarnation|inspection|inspect.*registration/iu,
  );
  assert.match(history, /participat/iu);
  assert.match(history, /barrier|fence/iu);
  assert.match(history, /separate|independent|distinct/iu);
  assert.match(history, /not|never|cannot/iu);
  assert.match(history, /stop/iu);
});
