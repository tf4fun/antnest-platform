import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [action, project, agentID, oldName] = process.argv.slice(2);
assert(
  ["delete", "tamper", "verify", "verify-drift", "snapshot"].includes(action),
);
assert(/^antnest-stage3-e2e-[0-9]+$/.test(project));
assert(/^agent_[0-9a-f]{32}$/.test(agentID));
if (action.startsWith("verify"))
  assert(/^antnest-skills-[0-9a-f]{32}-m[1-9][0-9]*$/.test(oldName));

function docker(...args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 30000,
  }).trim();
}
function ownedVolumes() {
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
  return names.map((name) => {
    const [volume] = JSON.parse(docker("volume", "inspect", name));
    assert.equal(volume.Name, name);
    assert.equal(volume.Labels["io.antnest.runtime-controller-scope"], project);
    assert.equal(volume.Labels["io.antnest.agent-id"], agentID);
    assert.equal(volume.Labels["io.antnest.managed"], "skill-set");
    assert.match(
      volume.Labels["io.antnest.skill-set-digest"],
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.match(name, /^antnest-skills-[0-9a-f]{32}-m[1-9][0-9]*$/);
    return {
      name,
      materialization: Number(
        volume.Labels["io.antnest.skill-materialization"],
      ),
      digest: volume.Labels["io.antnest.skill-set-digest"],
    };
  });
}

const containers = docker(
  "ps",
  "-aq",
  "--filter",
  `label=io.antnest.runtime-controller-scope=${project}`,
  "--filter",
  `label=io.antnest.agent-id=${agentID}`,
  "--filter",
  "label=io.antnest.managed=runtime",
);
if (action === "snapshot") {
  assert.notEqual(containers, "", "active Agent lacks a Runtime container");
  const volumes = ownedVolumes();
  assert.equal(
    volumes.length,
    1,
    "active Agent did not retain exactly one Skill volume",
  );
  process.stdout.write(volumes[0].name);
} else if (action === "delete" || action === "tamper") {
  assert.equal(containers, "", "disabled Agent still has a Runtime container");
  const volumes = ownedVolumes();
  assert.equal(
    volumes.length,
    1,
    "expected exactly one retained system Skill volume",
  );
  if (action === "delete") {
    docker("volume", "rm", volumes[0].name);
    assert.equal(ownedVolumes().length, 0, "lost Skill volume still exists");
  } else {
    const temporary = mkdtempSync(join(tmpdir(), "antnest-skill-drift-"));
    const helper = `${project}-skill-drift-helper`;
    try {
      const content =
        "---\nname: code-review\ndescription: Review code\n---\nTampered preset Skill body.\n";
      const source = join(temporary, "SKILL.md");
      const copied = join(temporary, "copied-SKILL.md");
      writeFileSync(source, content);
      docker(
        "create",
        "--name",
        helper,
        "--network",
        "none",
        "-v",
        `${volumes[0].name}:/skills`,
        "antnest/agent-acp-service:local",
      );
      docker("cp", source, `${helper}:/skills/code-review/SKILL.md`);
      docker("cp", `${helper}:/skills/code-review/SKILL.md`, copied);
      assert.equal(readFileSync(copied, "utf8"), content);
    } finally {
      docker("rm", "-f", helper);
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  process.stdout.write(volumes[0].name);
} else {
  assert.notEqual(containers, "", "enabled Agent lacks a Runtime container");
  const volumes = ownedVolumes();
  assert.equal(
    volumes.length,
    1,
    "enabled Agent did not get one new Skill volume",
  );
  assert.notEqual(
    volumes[0].name,
    oldName,
    "Enable reused the invalid Skill materialization",
  );
  assert.equal(
    volumes[0].name.replace(/-m[0-9]+$/, ""),
    oldName.replace(/-m[0-9]+$/, ""),
    "Enable changed the frozen Skill collection",
  );
  assert.equal(
    volumes[0].materialization,
    Number(oldName.match(/-m([0-9]+)$/)[1]) + 1,
    "Enable did not advance to the next materialization",
  );
  assert.equal(
    docker("volume", "ls", "-q", "--filter", `name=${oldName}`),
    "",
    "invalid materialization reappeared",
  );
  console.log(
    JSON.stringify({
      status:
        action === "verify-drift"
          ? "ready_volume_drift_recovered"
          : "ready_volume_loss_recovered",
      old_volume: oldName,
      new_volume: volumes[0].name,
    }),
  );
}
