import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prepareOwnerProfile } from "./owner-profile.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));

async function withFixture(work) {
  const parent = resolve(root, "artifacts/verification/authenticated-e2e");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const project = `antnest-lifecycle-${randomBytes(4).toString("hex")}`;
  const directory = join(parent, project);
  // mkdir is exclusive so cleanup can only remove this test's own project.
  mkdirSync(directory, { mode: 0o700 });
  try {
    const credentials = join(directory, "credentials");
    mkdirSync(credentials, { mode: 0o700 });
    const config = {
      project,
      credentials,
      env: {
        ANTNEST_SERVICE_NETWORK_PREFIX: "10.244.73",
        ANTNEST_SERVICE_AUTH_UID: String(process.getuid()),
        ANTNEST_SERVICE_AUTH_GID: String(process.getgid()),
        RETAINED_FIXTURE_VALUE: "unchanged",
      },
    };
    await work({ config, credentials, directory });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const prefix of ["10.244.1", "10.244.200"]) {
  test(`owner profile creates one private scoped member at prefix ${prefix}`, async () => {
    await withFixture(async ({ config, credentials }) => {
      config.env.ANTNEST_SERVICE_NETWORK_PREFIX = prefix;
      const original = structuredClone(config);
      await prepareOwnerProfile(config);
      const membersFile = join(credentials, "acp-members.json");
      const raw = readFileSync(membersFile, "utf8");
      assert.equal(lstatSync(membersFile).isFile(), true);
      assert.equal(statSync(membersFile).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(raw), {
        version: 1,
        members: [
          {
            member_id: "acp-a",
            container_selector: `${config.project}-agent-acp-service-1`,
            network: `${config.project}_controller-runtime`,
            probe_origin: "http://agent-acp-service:8085",
          },
        ],
      });
      assert.doesNotMatch(raw, /nonce|token/iu);
      assert.deepEqual(readdirSync(credentials), ["acp-members.json"]);
      assert.deepEqual(config, {
        ...original,
        ownerProfiles: ["acp-owner-bootstrap"],
        env: {
          ...original.env,
          ANTNEST_E2E_ACP_MEMBERS_FILE: membersFile,
        },
      });
    });
  });
}

test("owner profile reentry rejects without replacing the existing file or changing config", async () => {
  await withFixture(async ({ config, credentials }) => {
    await prepareOwnerProfile(config);
    const membersFile = join(credentials, "acp-members.json");
    const before = readFileSync(membersFile);
    const metadata = statSync(membersFile, { bigint: true });
    const original = structuredClone(config);
    await assert.rejects(
      Promise.resolve().then(() => prepareOwnerProfile(config)),
    );
    assert.deepEqual(config, original);
    assert.deepEqual(readFileSync(membersFile), before);
    const after = statSync(membersFile, { bigint: true });
    assert.equal(after.ino, metadata.ino);
    assert.equal(after.mtimeNs, metadata.mtimeNs);
    assert.equal(after.mode & 0o777n, 0o600n);
  });
});

const invalid = [
  [
    "foreign project scope",
    ({ config }) => {
      config.project = "foreign-project";
    },
  ],
  [
    "different valid project scope",
    ({ config }) => {
      config.project = `antnest-lifecycle-${config.project.endsWith("00000000") ? "11111111" : "00000000"}`;
    },
  ],
  [
    "zero prefix octet",
    ({ config }) => {
      config.env.ANTNEST_SERVICE_NETWORK_PREFIX = "10.244.0";
    },
  ],
  [
    "prefix above the owned range",
    ({ config }) => {
      config.env.ANTNEST_SERVICE_NETWORK_PREFIX = "10.244.201";
    },
  ],
  [
    "foreign prefix",
    ({ config }) => {
      config.env.ANTNEST_SERVICE_NETWORK_PREFIX = "10.243.73";
    },
  ],
  [
    "different UID",
    ({ config }) => {
      config.env.ANTNEST_SERVICE_AUTH_UID = String(process.getuid() + 1);
    },
  ],
  [
    "different GID",
    ({ config }) => {
      config.env.ANTNEST_SERVICE_AUTH_GID = String(process.getgid() + 1);
    },
  ],
  [
    "missing UID",
    ({ config }) => {
      delete config.env.ANTNEST_SERVICE_AUTH_UID;
    },
  ],
  [
    "missing GID",
    ({ config }) => {
      delete config.env.ANTNEST_SERVICE_AUTH_GID;
    },
  ],
  [
    "noncanonical credentials directory",
    ({ config, directory }) => {
      config.credentials = join(directory, "other-credentials");
      mkdirSync(config.credentials, { mode: 0o700 });
    },
  ],
  [
    "relative credentials directory",
    ({ config }) => {
      config.credentials = relative(root, config.credentials);
    },
  ],
  [
    "missing credentials directory",
    ({ credentials }) => {
      rmSync(credentials, { recursive: true });
    },
  ],
];

for (const [name, change] of invalid) {
  test(`owner profile rejects ${name} before publishing environment or profiles`, async () => {
    await withFixture(async (fixture) => {
      const { config, credentials, directory } = fixture;
      config.ownerProfiles = ["retained-profile"];
      change(fixture);
      const original = structuredClone(config);
      const files = readdirSync(directory, { recursive: true }).sort();
      await assert.rejects(
        Promise.resolve().then(() => prepareOwnerProfile(config)),
      );
      assert.deepEqual(config, original);
      assert.deepEqual(
        readdirSync(directory, { recursive: true }).sort(),
        files,
      );
      assert.equal(existsSync(join(credentials, "acp-members.json")), false);
    });
  });
}

test("owner profile rejects a symlink member file without touching its target or config", async () => {
  await withFixture(async ({ config, credentials, directory }) => {
    const target = join(directory, "retained-member.json");
    const retained = '{"retained":"fixture"}\n';
    writeFileSync(target, retained, { flag: "wx", mode: 0o600 });
    const membersFile = join(credentials, "acp-members.json");
    symlinkSync(target, membersFile);
    config.ownerProfiles = ["retained-profile"];
    const original = structuredClone(config);
    const metadata = statSync(target, { bigint: true });
    await assert.rejects(
      Promise.resolve().then(() => prepareOwnerProfile(config)),
    );
    assert.deepEqual(config, original);
    assert.equal(lstatSync(membersFile).isSymbolicLink(), true);
    assert.equal(readFileSync(target, "utf8"), retained);
    const after = statSync(target, { bigint: true });
    assert.equal(after.ino, metadata.ino);
    assert.equal(after.mtimeNs, metadata.mtimeNs);
    assert.equal(after.mode & 0o777n, 0o600n);
  });
});
