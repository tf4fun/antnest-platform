import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const webRoot = fileURLToPath(new URL("../../", import.meta.url));
const ADAPTER = "server/src/adapters/acp-sdk.ts";
const LIFECYCLE = "server/src/adapters/acp-transport-lifecycle.ts";
const EXPERIMENTAL = /^@agentclientprotocol\/sdk\/experimental\//u;

function* sources(directory: string, prefix: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) yield* sources(join(directory, entry.name), name);
    else if (entry.name.endsWith(".ts")) yield name;
  }
}

function specifiersOf(source: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
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

function specifiersFor(relative: string): string[] {
  return specifiersOf(
    ts.createSourceFile(
      relative,
      readFileSync(join(webRoot, relative), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    ),
  );
}

function experimentalImporters(): string[] {
  const found: string[] = [];
  for (const relative of sources(join(webRoot, "server/src"), "server/src"))
    if (
      specifiersFor(relative).some((specifier) => EXPERIMENTAL.test(specifier))
    )
      found.push(relative);
  return found.sort();
}

test("the ACP SDK adapter is the only source importing experimental specifiers", () => {
  assert(existsSync(join(webRoot, ADAPTER)), `${ADAPTER} adapter exists`);
  assert.deepEqual(experimentalImporters(), [ADAPTER]);
});

test("the adapter exposes the experimental HTTP stream factory", async () => {
  const adapterURL = new URL(`../../${ADAPTER}`, import.meta.url);
  const adapter = await import(adapterURL.href).catch((error) => {
    if (
      error.code !== "ERR_MODULE_NOT_FOUND" ||
      (error.url !== adapterURL.href &&
        !error.message.includes(adapterURL.pathname))
    )
      throw error;
    return {};
  });
  assert.equal(
    typeof adapter.createHttpStream,
    "function",
    "createHttpStream is exported",
  );
});

test("the transport lifecycle consumes the adapter instead of the SDK", () => {
  const specifiers = specifiersFor(LIFECYCLE);
  assert(
    specifiers.includes("./acp-sdk.ts"),
    `${LIFECYCLE} imports ./acp-sdk.ts`,
  );
  assert.equal(
    specifiers.filter((specifier) => EXPERIMENTAL.test(specifier)).length,
    0,
    `${LIFECYCLE} has no direct experimental specifiers`,
  );
});
