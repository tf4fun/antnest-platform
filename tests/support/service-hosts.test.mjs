import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const script = new URL("tests/support/service-hosts.sh", root).pathname;

function composeListeners() {
  const expected = new Map();
  let service;
  for (const line of readFileSync(new URL("compose.yaml", root), "utf8").split(
    "\n",
  )) {
    const header = /^ {2}([a-z][a-z-]*):$/u.exec(line);
    if (header) service = header[1];
    const listener =
      /^ {6}ANTNEST_([A-Z_]+)_LISTEN: \$\{ANTNEST_SERVICE_NETWORK_PREFIX:-10\.241\.0\}\.(\d+):\d+$/u.exec(
        line,
      );
    if (!listener) continue;
    const name = listener[1] === "ACP_CONTROL" ? "agent-acp-control" : service;
    expected.set(name, listener[2]);
  }
  return expected;
}

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
