import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const serviceRoot = fileURLToPath(new URL("../", import.meta.url));
const ADAPTER = "src/transport/acp/sdk.ts";
const EXPERIMENTAL = /^@agentclientprotocol\/sdk\/experimental\//u;
const SPECIFIER =
  /\b(?:import|export)\b[^;"'\n]*?\bfrom\s+["']([^"'\n]+)["']|\bimport\s*\(\s*["']([^"'\n]+)["']|\bimport\s+["']([^"'\n]+)["']/gsu;

function* sources(directory, prefix) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) yield* sources(join(directory, entry.name), name);
    else if (entry.name.endsWith(".ts")) yield name;
  }
}

function experimentalImporters(root) {
  const found = [];
  for (const relative of sources(join(root, "src"), "src")) {
    const text = readFileSync(join(root, relative), "utf8");
    for (const match of text.matchAll(SPECIFIER))
      if (EXPERIMENTAL.test(match[1] ?? match[2] ?? match[3])) {
        found.push(relative);
        break;
      }
  }
  return found.sort();
}

test("the SDK adapter is the only source importing experimental specifiers", () => {
  assert(existsSync(join(serviceRoot, ADAPTER)), `${ADAPTER} adapter exists`);
  assert.deepEqual(experimentalImporters(serviceRoot), [ADAPTER]);
});

test("the adapter exposes the server, node handler, v2 surface and shared types", async () => {
  const adapterURL = new URL(`../${ADAPTER}`, import.meta.url);
  const adapter = await import(adapterURL).catch((error) => {
    if (
      error.code !== "ERR_MODULE_NOT_FOUND" ||
      (error.url !== adapterURL.href && !error.message.includes(adapterURL.pathname))
    )
      throw error;
    return {};
  });
  assert.equal(typeof adapter.AcpServer, "function", "AcpServer is exported");
  assert.equal(
    typeof adapter.createNodeHttpHandler,
    "function",
    "createNodeHttpHandler is exported",
  );
  assert.equal(typeof adapter.v2?.agent, "function", "v2.agent is exported");
  const source = existsSync(join(serviceRoot, ADAPTER))
    ? readFileSync(join(serviceRoot, ADAPTER), "utf8")
    : "";
  assert.match(source, /ToolCallContent/u);
});

test("eslint restricts experimental SDK imports to the adapter", () => {
  const config = readFileSync(join(serviceRoot, "eslint.config.js"), "utf8");
  assert.match(config, /no-restricted-imports/u);
  assert.match(config, /transport\/acp\/sdk\.ts/u);
});
