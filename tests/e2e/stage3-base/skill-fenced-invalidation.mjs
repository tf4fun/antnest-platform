import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const [project, agentID] = process.argv.slice(2);
assert(/^antnest-stage3-e2e-[0-9]+$/.test(project));
assert(/^agent_[0-9a-f]{32}$/.test(agentID));
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 30000 }).trim();
const containers = docker(
  "ps",
  "-q",
  "--filter",
  `label=io.antnest.runtime-controller-scope=${project}`,
  "--filter",
  `label=io.antnest.agent-id=${agentID}`,
  "--filter",
  "label=io.antnest.managed=runtime",
)
  .split("\n")
  .filter(Boolean);
assert.equal(
  containers.length,
  1,
  "source Runtime must remain mounted during fenced Rebuild",
);
const source = JSON.parse(docker("inspect", containers[0]))[0];
const current = source.Mounts.find((mount) => mount.Destination === "/skills");
assert(current?.Name, "source Runtime has no Skill mount");
const names = docker(
  "volume",
  "ls",
  "-q",
  "--filter",
  `label=io.antnest.runtime-controller-scope=${project}`,
  "--filter",
  `label=io.antnest.agent-id=${agentID}`,
  "--filter",
  "label=io.antnest.managed=skill-set",
)
  .split("\n")
  .filter(Boolean);
assert.equal(
  names.length,
  2,
  "Rebuild must prepare exactly one new target collection",
);
const target = names.find((name) => name !== current.Name);
assert(target, "target Skill volume was not found");
const [volume] = JSON.parse(docker("volume", "inspect", target));
assert.equal(volume.Labels["io.antnest.managed"], "skill-set");
assert.equal(volume.Labels["io.antnest.agent-id"], agentID);
assert.match(
  volume.Labels["io.antnest.skill-set-digest"],
  /^sha256:[0-9a-f]{64}$/,
);
docker("volume", "rm", target);
assert.equal(docker("volume", "ls", "-q", "--filter", `name=${target}`), "");
process.stdout.write(target);
