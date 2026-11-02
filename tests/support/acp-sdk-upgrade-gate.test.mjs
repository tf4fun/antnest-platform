import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { selectSuites } from "./ci-changes.mjs";
import { selectComponents } from "./ci-impact.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const acpRequire = createRequire(
  new URL("../../services/agent-acp-service/package.json", import.meta.url),
);
const ts = acpRequire("typescript");

const SHARED_DEPENDENCY_FILES = [
  "tests/support/shared-versions.json",
  "services/agent-acp-service/package.json",
  "services/agent-acp-service/package-lock.json",
  "services/agent-ui/web/package.json",
  "services/agent-ui/web/package-lock.json",
];
const GENERATED = new Set([
  ".git",
  "node_modules",
  "dist",
  ".cache",
  "target",
  "artifacts",
  "coverage",
]);
const DIST_SPECIFIER = /(?:^|\/)@agentclientprotocol\/sdk\/dist\//u;

function* sources(directory, prefix) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!GENERATED.has(entry.name))
        yield* sources(join(directory, entry.name), name);
    } else if (/\.(?:mjs|ts|js)$/u.test(entry.name)) yield name;
  }
}

function specifiersOf(source) {
  const specifiers = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    )
      specifiers.push(node.moduleSpecifier.text);
    else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    )
      specifiers.push(node.argument.literal.text);
    else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    )
      specifiers.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

test("shared SDK gate files select both the ACP service and Agent UI components", () => {
  for (const file of SHARED_DEPENDENCY_FILES) {
    const selected = selectComponents([file]);
    for (const component of ["agent-acp-service", "agent-ui"])
      assert(selected.includes(component), `${file} selects ${component}`);
  }
});

test("the shared manifest selection is explicit, not reference-graph fallback", () => {
  assert.deepEqual(
    selectComponents(["tests/support/shared-versions.json"], {
      sources: { list: () => [], read: () => "" },
    }),
    ["agent-acp-service", "agent-ui"],
  );
});

test("the Agent UI workflow builds the ACP service and runs the SDK interop gate", () => {
  const workflow = readFileSync(
    join(root, ".github/workflows/agent-ui.yml"),
    "utf8",
  );
  assert(
    workflow
      .split("\n")
      .some(
        (line) =>
          line.includes("services/agent-acp-service") && line.includes("build"),
      ),
    "agent-ui.yml builds services/agent-acp-service",
  );
  assert.match(
    workflow,
    /npm run test:sdk:interop/u,
    "agent-ui.yml runs npm run test:sdk:interop",
  );
});

test("the interop script builds the UI server then runs the wire test", () => {
  const manifest = JSON.parse(
    readFileSync(join(root, "services/agent-ui/web/package.json"), "utf8"),
  );
  const script = manifest.scripts["test:sdk:interop"];
  assert.equal(typeof script, "string", "test:sdk:interop script exists");
  assert.match(script, /build/u, "script builds the UI server");
  assert.match(
    script,
    /acp-sdk-interop\.test\.mjs/u,
    "script runs the interop test file",
  );
});

test("the shared manifest also selects the ACP and UI component suites", () => {
  const selected = selectSuites(["tests/support/shared-versions.json"]).map(
    (suite) => suite.id,
  );
  for (const id of ["agent-acp-postgres", "agent-ui-browser"])
    assert(selected.includes(id), `shared manifest selects ${id}`);
});

test("the repository gate always runs the SDK interop check", () => {
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  assert(
    ci.includes("npm --prefix services/agent-ui/web run test:sdk:interop"),
    "ci.yml runs npm --prefix services/agent-ui/web run test:sdk:interop",
  );
});

function indentedBlock(config, pattern) {
  const match = new RegExp(
    `(?:^|\\n)( *)${pattern}\\n((?:\\1 +[^\\n]*\\n?)*)`,
    "u",
  ).exec(config);
  return match?.[2] ?? "";
}

test("dependabot groups multi-directory SDK updates by dependency name", () => {
  const config = readFileSync(join(root, ".github/dependabot.yml"), "utf8");
  const npm = indentedBlock(config, '- package-ecosystem: "npm"');
  assert(
    npm.includes('"/services/agent-acp-service"'),
    "npm directories include the ACP service",
  );
  assert(
    npm.includes('"/services/agent-ui/web"'),
    "npm directories include Agent UI",
  );
  const stable = indentedBlock(config, "acp-sdk:");
  assert.match(stable, /group-by: dependency-name/u);
  assert.match(stable, /@agentclientprotocol\/\*/u);
  const security = indentedBlock(config, "acp-sdk-security:");
  assert.match(security, /applies-to: security-updates/u);
  assert.match(security, /group-by: dependency-name/u);
  assert.match(security, /@agentclientprotocol\/\*/u);
});

test("the dist detector catches package and filesystem specifiers only", () => {
  const source = ts.createSourceFile(
    "fixture.mjs",
    [
      'import "@agentclientprotocol/sdk/dist/acp.js";',
      'export * from "../../../node_modules/@agentclientprotocol/sdk/dist/server.js";',
      'const lazy = import("../node_modules/@agentclientprotocol/sdk/dist/node-adapter.js");',
      'import { agent } from "@agentclientprotocol/sdk/experimental/v2";',
      'const local = require("./dist/acp.js");',
      'const name = "@agentclientprotocol/sdk/dist/acp.js";',
    ].join("\n"),
    ts.ScriptTarget.Latest,
    true,
  );
  assert.deepEqual(
    specifiersOf(source).filter((specifier) => DIST_SPECIFIER.test(specifier)),
    [
      "@agentclientprotocol/sdk/dist/acp.js",
      "../../../node_modules/@agentclientprotocol/sdk/dist/server.js",
      "../node_modules/@agentclientprotocol/sdk/dist/node-adapter.js",
    ],
  );
});

test("no source deep-imports SDK dist internals", () => {
  const offenders = [];
  for (const relative of sources(root, "")) {
    const source = ts.createSourceFile(
      relative,
      readFileSync(join(root, relative), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    if (
      specifiersOf(source).some((specifier) => DIST_SPECIFIER.test(specifier))
    )
      offenders.push(relative);
  }
  assert.deepEqual(offenders, []);
});

const helperURL = new URL("./acp-sdk.mjs", import.meta.url);
const helper = await import(helperURL).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    (error.url !== helperURL.href &&
      !error.message.includes(helperURL.pathname))
  )
    throw error;
  return {};
});

test("the shared SDK helper re-exports the public surface", () => {
  assert.ok(helper.acp, "acp namespace is exported");
  for (const name of ["createHttpStream", "AcpServer", "createNodeHttpHandler"])
    assert.equal(typeof helper[name], "function", `${name} is exported`);
});
