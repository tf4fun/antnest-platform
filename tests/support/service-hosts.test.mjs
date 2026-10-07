import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { composeListeners } from "./compose-listeners.mjs";

const root = new URL("../../", import.meta.url);
const script = new URL("tests/support/service-hosts.sh", root).pathname;

test("client host pins follow every Compose service listener", () => {
  const expected = composeListeners();
  assert(expected.size >= 8, "Compose listeners not found");
  const output = execFileSync(
    "sh",
    ["-c", '. "$1"; printf "%s\\n" $service_hosts', "sh", script],
    { env: { ...process.env, ANTNEST_SERVICE_NETWORK_PREFIX: "10.9.8" } },
  )
    .toString()
    .trim()
    .split("\n");
  assert.deepEqual(
    new Map(
      output.map((option) => {
        const match = /^--add-host=([a-z-]+):10\.9\.8\.(\d+)$/u.exec(option);
        assert(match, `unexpected host option ${option}`);
        return [match[1], match[2]];
      }),
    ),
    expected,
  );
});

test("Stage 3a test clients pin service names", () => {
  const directory = new URL("tests/e2e/", root);
  const launches = readdirSync(directory)
    .filter((name) => name.endsWith(".sh"))
    .filter((name) =>
      /docker(?:_cmd)? create --name "\$client"/u.test(
        readFileSync(new URL(name, directory), "utf8"),
      ),
    );
  assert(launches.length >= 10, "client launch scripts not found");
  for (const name of launches) {
    const source = readFileSync(new URL(name, directory), "utf8");
    assert.match(source, /tests\/support\/service-hosts\.sh"/u, name);
    assert.match(source, /\$service_hosts/u, name);
  }
});
