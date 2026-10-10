import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(
  new URL("../../services/agent-acp-service/package.json", import.meta.url),
);
const ts = require("typescript");
const contract = (name) =>
  JSON.parse(readFileSync(join(root, "contracts/edge-gateway", name), "utf8"));

export function collectHeaderSources(directory = root) {
  const sources = {};
  function visit(relative) {
    for (const entry of readdirSync(join(directory, relative), {
      withFileTypes: true,
    })) {
      if (
        [
          "node_modules",
          "target",
          "dist",
          "static",
          "test",
          "tests",
          "fixtures",
          "generated",
          ".cache",
        ].includes(entry.name)
      )
        continue;
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (
        /\.(?:go|tsx?|rs)$/u.test(path) &&
        !/(?:_test\.go|_tests?\.rs|\.(?:test|spec)\.[jt]sx?|\.gen\.go|\.pb\.go)$/u.test(
          path,
        )
      ) {
        const source = readFileSync(join(directory, path), "utf8");
        if (
          !/^(?:\/\/|\/\*)[^\n]*(?:Code generated .* DO NOT EDIT|@generated)/mu.test(
            source,
          )
        )
          sources[path] = source;
      }
    }
  }
  for (const directory of ["services", "runtimes", "modules"]) visit(directory);
  return sources;
}

function typescriptStrings(path, source) {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const strings = [];
  function stringValue(node) {
    if (!ts.isJsxAttribute(node.parent) || !node.text.includes("&"))
      return node.text;
    // Let the same compiler decode JSX entities. JavaScript strings and
    // templates must not receive HTML decoding, nor JSX JavaScript escapes.
    const emitted = ts.transpileModule(
      `const attribute = <entry value=${node.getText(file)} />;`,
      { compilerOptions: { jsx: ts.JsxEmit.React } },
    );
    const decoded = ts.createSourceFile(
      "attribute.js",
      emitted.outputText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    let value;
    function findValue(candidate) {
      if (
        ts.isPropertyAssignment(candidate) &&
        candidate.name.getText(decoded) === "value" &&
        ts.isStringLiteral(candidate.initializer)
      )
        value = candidate.initializer.text;
      ts.forEachChild(candidate, findValue);
    }
    findValue(decoded);
    if (value === undefined)
      throw new Error(`${path}: cannot decode JSX attribute`);
    return value;
  }
  function visit(node) {
    if (ts.isStringLiteralLike(node))
      strings.push({
        value: stringValue(node),
        start: node.getStart(file),
        constructed:
          ts.isBinaryExpression(node.parent) &&
          node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken,
      });
    else if (ts.isTemplateExpression(node))
      strings.push({
        value:
          node.head.text +
          node.templateSpans
            .map(
              (span) =>
                "${" + span.expression.getText(file) + "}" + span.literal.text,
            )
            .join(""),
        start: node.getStart(file),
        template: true,
      });
    ts.forEachChild(node, visit);
  }
  visit(file);
  return strings;
}

function decodeQuoted(value) {
  return value.replace(
    /\\(?:u\{[\da-fA-F_]+\}|u[\da-fA-F]{4}|U[\da-fA-F]{8}|x[\da-fA-F]{2}|[0-7]{3}|\r?\n\s*|.)/gu,
    (escape) => {
      const tail = escape.slice(1);
      if (/^u\{/u.test(tail))
        return String.fromCodePoint(
          parseInt(tail.slice(2, -1).replaceAll("_", ""), 16),
        );
      if (/^[uxU]/u.test(tail))
        return String.fromCodePoint(parseInt(tail.slice(1), 16));
      if (/^[0-7]{3}$/u.test(tail))
        return String.fromCharCode(parseInt(tail, 8));
      if (/^[\r\n]/u.test(tail)) return "";
      return (
        {
          a: "\x07",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
          v: "\v",
          0: "\0",
        }[tail] ?? tail
      );
    },
  );
}

// Go and Rust string tokens have a small shared lexical boundary. Mask comments
// and strings before finding Rust test modules, so braces inside them cannot
// hide following production declarations. TS/TSX uses its compiler parser.
function nativeStrings(path, source) {
  const rust = path.endsWith(".rs");
  const strings = [];
  const masked = source.split("");
  const mask = (start, end) => {
    for (let i = start; i < end; i++)
      if (!/[\r\n]/u.test(masked[i])) masked[i] = " ";
  };
  for (let index = 0; index < source.length;) {
    const start = index;
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      index = end < 0 ? source.length : end;
      mask(start, index);
      continue;
    }
    if (source.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < source.length && depth) {
        if (rust && source.startsWith("/*", index)) {
          depth++;
          index += 2;
        } else if (source.startsWith("*/", index)) {
          depth--;
          index += 2;
        } else index++;
      }
      mask(start, index);
      continue;
    }
    const raw =
      rust &&
      (source[index] === "r" || source[index] === "b") &&
      /^(?:br|r)(#*)"/u.exec(source.slice(index));
    if (raw) {
      const from = index + raw[0].length;
      const suffix = '"' + raw[1];
      const end = source.indexOf(suffix, from);
      if (end < 0) throw new Error(`${path}: unterminated raw string`);
      index = end + suffix.length;
      strings.push({
        value: source.slice(from, end),
        start,
        constructed: /^\s*\+/u.test(source.slice(index)),
      });
      mask(start, index);
      continue;
    }
    const quote = source[index];
    if (
      quote === '"' ||
      (!rust && quote === "`") ||
      (quote === "'" &&
        (!rust ||
          /^'(?:\\(?:u\{[\da-fA-F_]+\}|.)|[^'\\])'/u.test(source.slice(index))))
    ) {
      index++;
      const from = index;
      while (index < source.length && source[index] !== quote) {
        if (quote !== "`" && source[index] === "\\") index++;
        index++;
      }
      if (index >= source.length)
        throw new Error(`${path}: unterminated string`);
      const rawValue = source.slice(from, index++);
      if (quote !== "'")
        strings.push({
          value:
            quote === "`"
              ? rawValue.replaceAll("\r", "")
              : decodeQuoted(rawValue),
          start,
          constructed: /^\s*\+/u.test(source.slice(index)),
        });
      mask(start, index);
      continue;
    }
    index++;
  }
  if (!rust) return strings;
  const code = masked.join("");
  const excluded = [];
  const blocks = [];
  const open = [];
  for (let index = 0; index < code.length; index++) {
    if (code[index] === "{") open.push(index);
    else if (code[index] === "}" && open.length)
      blocks.push([open.pop(), index + 1]);
  }
  for (const match of code.matchAll(
    /#\s*!\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/gu,
  )) {
    const enclosing = blocks
      .filter(([from, to]) => from < match.index && match.index < to)
      .sort(([a], [b]) => b - a)[0];
    if (!enclosing) return []; // Only a crate-level inner attribute excludes the whole file.
    excluded.push(enclosing);
  }
  for (const match of code.matchAll(/#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/gu)) {
    let index = match.index + match[0].length;
    const delimiters = [];
    for (; index < code.length; index++) {
      const token = code[index];
      if (!delimiters.length) {
        // Attributes also apply to comma-terminated arms and fields. Never
        // consume a following production sibling or an enclosing block.
        if (token === "," || token === ";") {
          index++;
          break;
        }
        if (token === "}") break;
        if (token === "{") {
          const block = blocks.find(([from]) => from === index);
          if (block) index = block[1];
          break;
        }
      }
      if ("([{".includes(token)) delimiters.push(token);
      else if (")]}".includes(token)) delimiters.pop();
    }
    excluded.push([match.index, index]);
  }
  return strings.filter(
    ({ start }) => !excluded.some(([from, to]) => start >= from && start < to),
  );
}

export function checkTrustedHeaders({
  sources = collectHeaderSources(),
  registry = contract("request-headers.json"),
  nonHeaders = contract("non-header-vocabulary.json"),
} = {}) {
  const errors = [];
  const registered = new Set(
    registry.headers.map(({ name }) => name.toLowerCase()),
  );
  const prefixes = registry.reserved_prefixes.map((value) =>
    value.toLowerCase(),
  );
  const roles = new Set([
    "browser-local",
    "validated-precondition",
    "presentation-hint",
    "internal-credential",
    "internal-fence",
    "response-only",
    "retired",
  ]);
  if (registered.size !== registry.headers.length)
    errors.push("duplicate registered header name");
  for (const entry of registry.headers)
    if (
      !roles.has(entry.role) ||
      !entry.owner ||
      !prefixes.some((prefix) => entry.name.toLowerCase().startsWith(prefix))
    )
      errors.push(`invalid header registration: ${entry.name}`);
  const exceptions = new Map();
  for (const entry of nonHeaders) {
    const value = entry.value.toLowerCase();
    if (registered.has(value))
      errors.push(`header and non-header exception overlap: ${entry.value}`);
    if (exceptions.has(value) || !entry.purpose || !entry.source)
      errors.push(`invalid non-header exception: ${entry.value}`);
    exceptions.set(value, entry);
  }
  const headers = new Set();
  for (const [path, source] of Object.entries(sources)) {
    const literals = /\.tsx?$/u.test(path)
      ? typescriptStrings(path, source)
      : nativeStrings(path, source);
    for (const literal of literals) {
      const value = literal.value.toLowerCase();
      if (!prefixes.some((prefix) => value.startsWith(prefix))) continue;
      if (registered.has(value) && !literal.template) {
        headers.add(value);
        continue;
      }
      // Namespace matchers are not header names; constructing a name from one
      // still needs review. Multipart's one reviewed dynamic boundary is scoped
      // to its exact spelling and source, never a prefix exception.
      if (prefixes.includes(value) && !literal.constructed && !literal.template)
        continue;
      const exception = exceptions.get(value);
      if (
        exception &&
        Boolean(literal.template) === (exception.template === true) &&
        (exception.template !== true || exception.source === path) &&
        !(prefixes.includes(value) && literal.constructed)
      )
        continue;
      const line = source.slice(0, literal.start).split("\n").length;
      errors.push(
        `${path}:${line}: unregistered reserved literal ${JSON.stringify(literal.value)}`,
      );
    }
  }
  return {
    headers: [...headers].sort(),
    sources: Object.keys(sources).length,
    errors,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = checkTrustedHeaders();
  if (result.errors.length) {
    for (const error of result.errors) console.error(error);
    process.exitCode = 1;
  } else
    console.log(
      `checked ${result.headers.length} reserved header names in ${result.sources} production sources`,
    );
}
