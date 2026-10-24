import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const root = new URL("../../../", import.meta.url);
const require = createRequire(
  new URL("services/agent-acp-service/package.json", root),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const read = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const schema = read("contracts/agent-acp/owner-peer.schema.json");
const manifest = read("contracts/agent-acp/owner-peer-contract.json");
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(schema);
const validate = (name, value) =>
  ajv.validate({ $ref: `${schema.$id}#/$defs/${name}` }, value);
const registration = (member = "acp-a", prefix = "1") => ({
  member_id: member,
  registration_id: `${prefix.repeat(8)}-1111-4111-8111-111111111111`,
  incarnation_id: `${prefix.repeat(8)}-2222-4222-8222-222222222222`,
});
const publication = () => ({
  organization_id: "org-1",
  revision: 3,
  authority_sha256: "b".repeat(64),
});
const request = () => ({
  request_id: "33333333-3333-4333-8333-333333333333",
  deadline_at: "2026-10-24T08:00:10.000Z",
  membership_sha256: "a".repeat(64),
  source: registration(),
  target: registration("acp-b", "2"),
  publication: publication(),
  hop: 1,
});
const receipt = () => ({
  request_id: request().request_id,
  membership_sha256: request().membership_sha256,
  publication: publication(),
  registration: registration("acp-b", "2"),
  status: "applied",
  revocation: "joined",
  owned_agents: [{ agent_id: "agent-b", epoch: "9223372036854775807" }],
});

test("peer publication request and receipt retain process, authority and revocation identities", () => {
  assert(
    validate("publication_request", request()),
    JSON.stringify(ajv.errors),
  );
  assert(
    validate("publication_receipt", receipt()),
    JSON.stringify(ajv.errors),
  );
  assert(validate("publication_receipt", { ...receipt(), owned_agents: [] }));
});

test("peer identity discovery is challenged and returns only the current registration", () => {
  const identity = {
    request_id: request().request_id,
    deadline_at: request().deadline_at,
    membership_sha256: request().membership_sha256,
    source: registration(),
    target_member_id: "acp-b",
    challenge: "c".repeat(64),
  };
  assert(validate("identity_request", identity));
  assert(
    validate("identity_receipt", {
      request_id: identity.request_id,
      membership_sha256: identity.membership_sha256,
      challenge: identity.challenge,
      registration: registration("acp-b", "2"),
    }),
  );
  assert(
    !validate("identity_request", {
      ...identity,
      peer_url: "http://user-selected.invalid",
    }),
  );
});

for (const field of [
  "request_id",
  "deadline_at",
  "membership_sha256",
  "source",
  "target",
  "publication",
  "hop",
]) {
  test(`publication cannot omit ${field}`, () => {
    const value = request();
    delete value[field];
    assert(!validate("publication_request", value));
  });
}

for (const [label, edit] of [
  [
    "forwarding a second hop",
    (v) => {
      v.hop = 2;
    },
  ],
  [
    "request-selected peer address",
    (v) => {
      v.peer_url = "http://arbitrary.invalid";
    },
  ],
  [
    "partial target registration",
    (v) => {
      delete v.target.registration_id;
    },
  ],
  [
    "unsafe numeric publication revision",
    (v) => {
      v.publication.revision = 9007199254740992;
    },
  ],
  [
    "negative publication revision",
    (v) => {
      v.publication.revision = -1;
    },
  ],
  [
    "public authority substituted for its full digest",
    (v) => {
      v.publication.authority_sha256 = "";
    },
  ],
  [
    "unbounded local time",
    (v) => {
      v.deadline_at = "2026-10-24T08:00:10";
    },
  ],
  [
    "embedded private configuration",
    (v) => {
      v.publication.configuration = {};
    },
  ],
])
  test(`rejects ${label}`, () => {
    const value = request();
    edit(value);
    assert(!validate("publication_request", value));
  });

for (const [label, edit] of [
  [
    "missing revocation join",
    (v) => {
      delete v.revocation;
    },
  ],
  [
    "lease expiry used as revocation proof",
    (v) => {
      v.revocation = "lease_expired";
    },
  ],
  [
    "unready local graph",
    (v) => {
      v.status = "saved";
    },
  ],
  [
    "numeric epoch",
    (v) => {
      v.owned_agents[0].epoch = 1;
    },
  ],
  [
    "zero epoch",
    (v) => {
      v.owned_agents[0].epoch = "0";
    },
  ],
  [
    "noncanonical epoch",
    (v) => {
      v.owned_agents[0].epoch = "01";
    },
  ],
  [
    "oversized epoch",
    (v) => {
      v.owned_agents[0].epoch = "1".repeat(20);
    },
  ],
  [
    "unknown receipt field",
    (v) => {
      v.owner_lease_only = true;
    },
  ],
])
  test(`receipt rejects ${label}`, () => {
    const value = receipt();
    edit(value);
    assert(!validate("publication_receipt", value));
  });

test("planned peer operations are private, bounded and do not grant current caller access", () => {
  assert.equal(manifest.status, "planned");
  assert.equal(manifest.receiver, "agent-acp-service");
  assert.equal(manifest.listener, "peer");
  assert.equal(manifest.aggregate_deadline_ms, 10000);
  assert.deepEqual(Object.keys(manifest.operations).sort(), [
    "identity",
    "publish",
  ]);
  const callers = JSON.stringify(read("contracts/agent-acp/callers.json"));
  for (const operation of Object.values(manifest.operations)) {
    assert.equal(operation.method, "POST");
    assert.deepEqual(operation.callers, ["agent-acp-service"]);
    assert.equal(operation.caller_context, "none");
    assert.equal(operation.capture_payload, false);
    assert.equal(operation.cache_control, "no-store");
    assert(operation.request_bytes_max <= 16384);
    assert(operation.response_bytes_max <= 16777216);
    assert(!callers.includes(operation.path));
    assert(schema.$defs[operation.request]);
    assert(schema.$defs[operation.response]);
  }
});
