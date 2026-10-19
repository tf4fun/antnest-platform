import assert from "node:assert/strict";
import { runtimePhysical } from "../lifecycle-closeout/recovery-support.mjs";
import { runtimeStatus } from "../lifecycle-closeout/runtime-status.mjs";
import { runtimeBinding } from "./current-evidence.mjs";

export async function captureC4Runtime(
  name,
  { config, fixture, docker, signal, report },
  { physical = runtimePhysical, status = runtimeStatus } = {},
) {
  signal?.throwIfAborted();
  assert(["initial", "rebuilt"].includes(name));
  const entries = (report.runtime_bindings ??= []);
  assert(
    !entries.some((entry) => entry.name === name),
    "C4 Runtime already observed",
  );
  assert.equal(fixture.agentID, report.agent_id);
  const entry = { name };
  entries.push(entry);
  report.runtime_image_id = config.resolvedImage;
  const agent = await fixture.ready();
  entry.observed = { agent: structuredClone(agent) };
  signal?.throwIfAborted();
  const resources = await physical(docker, config, fixture.agentID);
  entry.physical = structuredClone(resources);
  entry.observed.volume = resources.volume;
  signal?.throwIfAborted();
  assert(
    resources.id && resources.volume && resources.running && resources.healthy,
    "ready C4 Runtime and retained workspace required",
  );
  const containers = JSON.parse(await docker(["inspect", resources.id]));
  entry.observed.container = structuredClone(containers[0]);
  signal?.throwIfAborted();
  assert.equal(containers.length, 1);
  const container = containers[0];
  assert.equal(container.Id, resources.id);
  assert.equal(container.Image, config.resolvedImage);
  assert.equal(container.State.Running, true);
  assert.equal(container.State.Health?.Status, "healthy");
  assert.equal(agent.agent_id, fixture.agentID);
  entry.status = structuredClone(
    await status(docker, config.project, container.Id, { signal }),
  );
  signal?.throwIfAborted();
  entry.binding = runtimeBinding(entry.observed, entry.status);
  return entry.binding;
}
