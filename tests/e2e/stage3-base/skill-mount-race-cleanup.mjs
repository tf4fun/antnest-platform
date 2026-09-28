import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const [receiptPath, project] = process.argv.slice(2);
assert(/^antnest-stage3-e2e-[0-9]+$/.test(project));
const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
assert.equal(receipt.scope, project);
assert(/^agent_[0-9a-f]{32}$/.test(receipt.agent_id));
assert(/^antnest-skills-[0-9a-f]{32}-m[1-9][0-9]*$/.test(receipt.volume));
assert.equal(receipt.deleted_before_create, true);
const responseLoss =
  process.env.ANTNEST_E2E_SKILL_MOUNT_RESPONSE_LOSS === "true";
assert.equal(receipt.create_response_dropped, responseLoss);
assert.equal(receipt.recovery_inspect_seen, responseLoss);
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 30000 }).trim();
const [volume] = JSON.parse(docker("volume", "inspect", receipt.volume));
assert.equal(volume.Name, receipt.volume);
assert.deepEqual(
  volume.Labels ?? {},
  {},
  "race volume acquired an unexpected owner",
);
if (process.env.ANTNEST_E2E_SKILL_INITIALIZE_RACE === "true") {
  assert.equal(
    docker(
      "ps",
      "-aq",
      "--filter",
      `label=io.antnest.runtime-controller-scope=${project}`,
      "--filter",
      `label=io.antnest.agent-id=${receipt.agent_id}`,
      "--filter",
      "label=io.antnest.managed=runtime",
    ),
    "",
    "initial Agent creation retained a Runtime candidate",
  );
}
const references = docker("ps", "-aq", "--filter", `volume=${receipt.volume}`)
  .split("\n")
  .filter(Boolean);
if (responseLoss) {
  assert.equal(
    references.length,
    1,
    "lost-response candidate was not retained for recovery",
  );
  const [candidate] = JSON.parse(docker("inspect", references[0]));
  assert.equal(candidate.Name, `/antnest-runtime-${receipt.agent_id}`);
  assert.equal(candidate.Config.Labels["io.antnest.managed"], "runtime");
  assert.equal(
    candidate.Config.Labels["io.antnest.runtime-controller-scope"],
    project,
  );
  assert.equal(
    candidate.Config.Labels["io.antnest.agent-id"],
    receipt.agent_id,
  );
  assert.equal(candidate.State.Status, "created");
  assert.equal(candidate.State.Running, false);
  assert(
    candidate.Mounts.some(
      (mount) =>
        mount.Type === "volume" &&
        mount.Name === receipt.volume &&
        mount.Destination === "/skills" &&
        mount.RW === false,
    ),
  );
  docker("rm", candidate.Id);
} else {
  assert.deepEqual(
    references,
    [],
    "untrusted race volume still has a container reference",
  );
}
docker("volume", "rm", receipt.volume);
assert.equal(
  docker("volume", "ls", "-q", "--filter", `name=${receipt.volume}`),
  "",
);
console.log(
  JSON.stringify({
    status: "untrusted_race_volume_removed",
    volume: receipt.volume,
    response_loss_candidate_removed: responseLoss,
  }),
);
