import assert from "node:assert/strict";
import { inspect } from "node:util";
import { createDevelopmentWriter } from "../../support/development-configuration.mjs";
import { createWorkspacePrivateAccess } from "../workspace-closeout/private-access.mjs";

// The callback owns the original driver assertions. Its result is released only
// after the private access, exporter and final evidence have all joined.
export async function withDevelopmentPrivateState(
  config,
  { browser, principal, secrets, signal },
  work,
  { createAccess = createWorkspacePrivateAccess } = {},
) {
  assert(config.privateAccess, "privateAccess is required");
  signal?.throwIfAborted();
  const login = { accessToken: browser?.accessToken };
  const original = structuredClone(principal);
  assert(
    typeof login.accessToken === "string" && login.accessToken,
    "original login session required",
  );
  for (const key of ["organization_id", "user_id"])
    assert(
      typeof original?.[key] === "string" && original[key],
      "original login Principal required",
    );
  assert(Array.isArray(secrets));
  assert.equal(typeof work, "function");
  const name = "private-access.private.json";
  const write = createDevelopmentWriter(config, [name]);
  const report = { states: [], authorities: [], closed: false, errors: [] };
  const save = () => write(name, report);
  // Claim the evidence before starting any private request or exporter.
  save();
  let access, result;
  const errors = [];
  try {
    access = await createAccess(
      { ...config, evidence: config.output },
      {
        signal,
        secrets,
        preserveState(index, value) {
          report.states[index - 1] = structuredClone(value);
          save();
        },
        preserveAuthority(scope, rows) {
          report.authorities[scope.operation_id - 1] = {
            ...structuredClone(scope),
            receipts: structuredClone(rows),
          };
          save();
        },
      },
    );
    result = await work({ state: (id) => access.state(id, login, original) });
    signal?.throwIfAborted();
  } catch (error) {
    errors.push(error);
  }
  if (access)
    try {
      await access.closeAndWait();
      report.closed = true;
    } catch (error) {
      errors.push(error);
    }
  report.errors = [...new Set(errors)].map((error) =>
    inspect(error, { depth: 8 }),
  );
  try {
    save();
  } catch (error) {
    errors.push(error);
  }
  const unique = [...new Set(errors)];
  if (unique.length === 1) throw unique[0];
  if (unique.length)
    throw new AggregateError(
      unique,
      "Development state, evidence or cleanup failed",
    );
  return result;
}
