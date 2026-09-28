import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const [action, project, agentID, oldTarget] = process.argv.slice(2);
assert(["tamper", "verify"].includes(action));
assert(/^antnest-stage3-e2e-[0-9]+$/.test(project));
assert(/^agent_[0-9a-f]{32}$/.test(agentID));
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 30000 }).trim();
const runtimeIDs = docker(
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
  runtimeIDs.length,
  1,
  "source Runtime must remain active before Drain",
);
const runtime = JSON.parse(docker("inspect", runtimeIDs[0]))[0];
const source = runtime.Mounts.find((mount) => mount.Destination === "/skills");
assert(source?.Name, "source Runtime has no Skill volume");
const volumes = docker(
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
assert.equal(volumes.length, 2, "expected source and unmounted target volumes");
const target = volumes.find((name) => name !== source.Name);
assert(target && /^antnest-skills-[0-9a-f]{32}-m[1-9][0-9]*$/.test(target));
const [volume] = JSON.parse(docker("volume", "inspect", target));
assert.equal(volume.Labels["io.antnest.agent-id"], agentID);
assert.equal(volume.Labels["io.antnest.managed"], "skill-set");
if (action === "tamper") {
  docker(
    "run",
    "--rm",
    "--network",
    "none",
    "--label",
    `com.docker.compose.project=${project}`,
    "--mount",
    `type=volume,source=${target},target=/skills`,
    "postgres:17.11-bookworm",
    "sh",
    "-c",
    "printf corrupt > /skills/.antnest-skills.json",
  );
  process.stdout.write(target);
} else {
  assert(/^antnest-skills-[0-9a-f]{32}-m[1-9][0-9]*$/.test(oldTarget));
  assert.notEqual(
    target,
    oldTarget,
    "drifted target materialization was reused",
  );
  assert.equal(
    target.replace(/-m[0-9]+$/, ""),
    oldTarget.replace(/-m[0-9]+$/, ""),
    "recovery changed the frozen target collection",
  );
  assert.equal(
    Number(target.match(/-m([0-9]+)$/)[1]),
    Number(oldTarget.match(/-m([0-9]+)$/)[1]) + 1,
  );
  assert.equal(
    docker("volume", "ls", "-q", "--filter", `name=${oldTarget}`),
    "",
  );
  const manifest = docker(
    "run",
    "--rm",
    "--network",
    "none",
    "--label",
    `com.docker.compose.project=${project}`,
    "--mount",
    `type=volume,source=${target},target=/skills,readonly`,
    "postgres:17.11-bookworm",
    "cat",
    "/skills/.antnest-skills.json",
  );
  assert.doesNotThrow(
    () => JSON.parse(manifest),
    "replacement manifest is invalid",
  );
  console.log(
    JSON.stringify({
      status: "target_skill_drift_rematerialized",
      source_volume: source.Name,
      old_target_volume: oldTarget,
      new_target_volume: target,
    }),
  );
}
