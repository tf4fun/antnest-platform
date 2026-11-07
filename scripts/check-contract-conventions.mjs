import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const CANONICAL_BASE = "https://schemas.antnest.dev/";
const ALIASES_PATH = "common/convention-aliases.json";
const BANNED_FIELDS = new Set([
  "expected_resource_version",
  "expected_revision",
  "nextCursor",
  "otherCursor",
  "olderCursor",
  "sealedCursor",
  "expectedAppendVersion",
  "next_after_id",
  "after_id",
  "next_after_version",
  "after_version",
]);
const ALIAS_KINDS = new Set([
  "deprecated_alias",
  "pending_migration",
  "protocol_exception",
]);
const FEED_FIELDS = ["next_cursor", "next_sequence", "after_sequence"];
const CURSOR_FIELDS = new Set(["cursor", "next_cursor"]);
const MAX_CURSOR_LENGTH = 4096;
const MAX_KEYS = new Set([
  "minimum",
  "minLength",
  "minItems",
  "minProperties",
  "exclusiveMinimum",
]);
const MIN_KEYS = new Set([
  "maximum",
  "maxLength",
  "maxItems",
  "maxProperties",
  "exclusiveMaximum",
]);

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const escapeSegment = (segment) =>
  segment.replace(/~/g, "~0").replace(/\//g, "~1");

const unescapeSegment = (segment) =>
  segment.replace(/~1/g, "/").replace(/~0/g, "~");

function pointAt(document, pointer) {
  let node = document;
  for (const raw of pointer.split("/").slice(1)) {
    if (node === null || typeof node !== "object") return undefined;
    const segment = unescapeSegment(raw);
    node = Array.isArray(node) ? node[Number(segment)] : node[segment];
  }
  return node;
}

function resolveRef(documents, fromKey, ref) {
  const base = CANONICAL_BASE + fromKey;
  const hash = ref.indexOf("#");
  const target = hash === -1 ? ref : ref.slice(0, hash);
  const fragment = hash === -1 ? "" : ref.slice(hash);
  let absolute;
  try {
    absolute = target === "" ? base : new URL(target, base).href.split("#")[0];
  } catch {
    return { error: `invalid $ref ${JSON.stringify(ref)}` };
  }
  if (!absolute.startsWith(CANONICAL_BASE))
    return { error: `non-canonical $ref ${JSON.stringify(ref)}` };
  let key;
  try {
    key = decodeURIComponent(absolute.slice(CANONICAL_BASE.length));
  } catch {
    return { error: `malformed $ref ${JSON.stringify(ref)}` };
  }
  const document = documents.get(key);
  if (document === undefined)
    return { error: `unresolved $ref ${JSON.stringify(ref)}` };
  if (fragment === "") return { key, node: document, fragment };
  if (!fragment.startsWith("#/"))
    return { error: `unsupported $ref fragment ${JSON.stringify(ref)}` };
  const node = pointAt(document, fragment.slice(1));
  if (node === undefined)
    return { error: `missing $ref fragment ${JSON.stringify(ref)}` };
  return { key, node, fragment };
}

function mergeSchema(into, node) {
  for (const [keyword, value] of Object.entries(node)) {
    if (MAX_KEYS.has(keyword) && typeof value === "number") {
      into[keyword] =
        into[keyword] === undefined ? value : Math.max(into[keyword], value);
    } else if (MIN_KEYS.has(keyword) && typeof value === "number") {
      into[keyword] =
        into[keyword] === undefined ? value : Math.min(into[keyword], value);
    } else if (keyword === "type") {
      const set = new Set(
        value instanceof Set ? value : Array.isArray(value) ? value : [value],
      );
      into.type =
        into.type === undefined
          ? set
          : new Set([...into.type].filter((type) => set.has(type)));
    } else if (keyword === "properties" && isObject(value)) {
      into.properties = into.properties ?? {};
      for (const [name, subschema] of Object.entries(value)) {
        if (!(name in into.properties)) into.properties[name] = subschema;
      }
    } else if (into[keyword] === undefined) {
      into[keyword] = value;
    }
  }
  return into;
}

function effectiveSchema(documents, key, node, trail) {
  let merged = mergeSchema({}, node);
  if (Array.isArray(node.allOf)) {
    for (const branch of node.allOf) {
      if (isObject(branch))
        merged = mergeSchema(
          merged,
          effectiveSchema(documents, key, branch, trail),
        );
    }
  }
  if (typeof node.$ref === "string") {
    const resolved = resolveRef(documents, key, node.$ref);
    if (resolved.node !== undefined) {
      const marker = `${resolved.key}${resolved.fragment}`;
      if (!trail.has(marker)) {
        trail.add(marker);
        merged = mergeSchema(
          merged,
          effectiveSchema(documents, resolved.key, resolved.node, trail),
        );
      }
    }
  }
  for (const keyword of ["oneOf", "anyOf"]) {
    const branches = node[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (!isObject(branch)) continue;
      const sub = effectiveSchema(documents, key, branch, trail);
      if (sub.type instanceof Set) {
        merged.type = merged.type ?? new Set();
        for (const type of sub.type) merged.type.add(type);
      }
    }
  }
  return merged;
}

export async function loadContracts(root) {
  const documents = new Map();
  async function visit(dir, prefix) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await visit(join(dir, entry.name), `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith(".json")) {
        const key = `${prefix}${entry.name}`;
        if (key === ALIASES_PATH) continue;
        documents.set(
          key,
          JSON.parse(await readFile(join(dir, entry.name), "utf8")),
        );
      }
    }
  }
  await visit(fileURLToPath(root), "");
  return documents;
}

export function checkConventions(documents, aliases = []) {
  const problems = [];
  const occurrences = [];
  const schemaKeys = new Set();
  const ids = new Map();

  for (const [key, document] of documents) {
    if (
      key.endsWith(".schema.json") ||
      (isObject(document) && "$schema" in document)
    )
      schemaKeys.add(key);
  }

  for (const [key, document] of documents) {
    const canonical = CANONICAL_BASE + key;
    if (schemaKeys.has(key)) {
      if (!isObject(document) || document.$schema !== DIALECT)
        problems.push(`${key}: $schema must be ${DIALECT}`);
      if (!isObject(document) || document.$id !== canonical)
        problems.push(`${key}: $id must be ${canonical}`);
      if (isObject(document) && typeof document.$id === "string") {
        const owners = ids.get(document.$id) ?? [];
        owners.push(key);
        ids.set(document.$id, owners);
      }
    }

    const walk = (node, pointer) => {
      if (Array.isArray(node)) {
        node.forEach((value, index) => {
          if (
            !schemaKeys.has(key) &&
            typeof value === "string" &&
            BANNED_FIELDS.has(value)
          )
            occurrences.push({
              file: key,
              pointer: `${pointer}/${index}`,
              field: value,
            });
          walk(value, `${pointer}/${index}`);
        });
        return;
      }
      if (!isObject(node)) return;
      if (schemaKeys.has(key) && "definitions" in node)
        problems.push(`${key}: ${pointer}/definitions must use $defs`);
      if (
        typeof node.$ref === "string" &&
        (schemaKeys.has(key) || !node.$ref.startsWith("#"))
      ) {
        const resolved = resolveRef(documents, key, node.$ref);
        if (resolved.error)
          problems.push(`${key}: ${pointer}/$ref ${resolved.error}`);
      }
      if (schemaKeys.has(key)) {
        if (isObject(node.properties)) {
          const merged = effectiveSchema(documents, key, node, new Set());
          const paginationContext =
            key === "common/pagination.schema.json" ||
            [
              "cursor",
              "next_cursor",
              "nextCursor",
              "after_id",
              "after_version",
            ].some((field) => field in node.properties);
          for (const name of Object.keys(node.properties)) {
            const at = `${pointer}/properties/${escapeSegment(name)}`;
            if (BANNED_FIELDS.has(name))
              occurrences.push({ file: key, pointer: at, field: name });
            if (CURSOR_FIELDS.has(name)) {
              const cursor = effectiveSchema(
                documents,
                key,
                node.properties[name],
                new Set(),
              );
              const types =
                cursor.type instanceof Set ? cursor.type : new Set();
              if (types.has("string")) {
                if (
                  cursor.maxLength === undefined ||
                  cursor.maxLength > MAX_CURSOR_LENGTH
                )
                  problems.push(
                    `${key}: ${at} must bound the cursor at maxLength <= ${MAX_CURSOR_LENGTH}`,
                  );
              } else {
                occurrences.push({ file: key, pointer: at, field: "$cursor" });
              }
            }
            if (name === "limit" && paginationContext) {
              const limit = effectiveSchema(
                documents,
                key,
                node.properties[name],
                new Set(),
              );
              const bounded =
                limit.type instanceof Set &&
                limit.type.has("integer") &&
                typeof limit.minimum === "number" &&
                limit.minimum >= 1 &&
                Number.isSafeInteger(limit.maximum) &&
                limit.maximum >= limit.minimum;
              if (!bounded)
                problems.push(
                  `${key}: ${at} limit must be an integer with minimum >= 1 and a finite safe maximum`,
                );
            }
          }
          const items = merged.properties?.items;
          if (items !== undefined) {
            const list = effectiveSchema(documents, key, items, new Set());
            const array =
              (list.type instanceof Set && list.type.has("array")) ||
              list.items !== undefined ||
              list.prefixItems !== undefined;
            if (
              array &&
              !FEED_FIELDS.some(
                (field) => merged.properties[field] !== undefined,
              )
            )
              occurrences.push({
                file: key,
                pointer,
                field: "$pagination",
              });
          }
        }
        if (Array.isArray(node.required))
          node.required.forEach((value, index) => {
            if (BANNED_FIELDS.has(value))
              occurrences.push({
                file: key,
                pointer: `${pointer}/required/${index}`,
                field: value,
              });
          });
      } else {
        for (const [name, value] of Object.entries(node)) {
          const at = `${pointer}/${escapeSegment(name)}`;
          if (BANNED_FIELDS.has(name))
            occurrences.push({ file: key, pointer: at, field: name });
          if (typeof value === "string" && BANNED_FIELDS.has(value))
            occurrences.push({ file: key, pointer: at, field: value });
        }
      }
      for (const [name, value] of Object.entries(node))
        walk(value, `${pointer}/${escapeSegment(name)}`);
    };
    walk(document, "");
  }

  for (const [id, owners] of ids) {
    if (owners.length > 1)
      for (const key of owners)
        problems.push(`${key}: $id ${id} is duplicated`);
  }

  const list = Array.isArray(aliases) ? aliases : [];
  if (!Array.isArray(aliases))
    problems.push("convention-aliases must be an array of alias objects");

  const valid = list.map((alias, index) => {
    const label = `convention-aliases[${index}]`;
    if (!isObject(alias)) {
      problems.push(`${label}: alias must be an object`);
      return false;
    }
    let ok = true;
    for (const field of [
      "file",
      "pointer",
      "field",
      "replacement",
      "reason",
      "remove_after",
    ]) {
      const bad =
        field === "pointer"
          ? typeof alias[field] !== "string"
          : typeof alias[field] !== "string" || alias[field] === "";
      if (bad) {
        problems.push(`${label}: ${field} must be a non-empty string`);
        ok = false;
      }
    }
    if (!ALIAS_KINDS.has(alias.kind)) {
      problems.push(
        `${label}: kind must be one of ${[...ALIAS_KINDS].join(", ")}`,
      );
      ok = false;
    }
    if (
      alias.kind === "protocol_exception" &&
      alias.remove_after !== "protocol"
    ) {
      problems.push(
        `${label}: protocol_exception remove_after must be "protocol"`,
      );
      ok = false;
    }
    return ok;
  });

  const signatures = new Set();
  list.forEach((alias, index) => {
    if (!valid[index] || !isObject(alias)) return;
    const signature = [alias.file, alias.pointer, alias.field].join("\u001f");
    if (signatures.has(signature))
      problems.push(`convention-aliases[${index}]: duplicate alias`);
    signatures.add(signature);
  });

  const applied = new Set();
  for (const occurrence of occurrences) {
    const needsProtocol =
      occurrence.field === "$cursor" || occurrence.file.startsWith("agent-ui/");
    const match = list.findIndex(
      (alias, index) =>
        valid[index] &&
        isObject(alias) &&
        alias.file === occurrence.file &&
        alias.pointer === occurrence.pointer &&
        alias.field === occurrence.field &&
        (!needsProtocol || alias.kind === "protocol_exception"),
    );
    if (match === -1) {
      problems.push(
        occurrence.field === "$pagination"
          ? `${occurrence.file}: ${occurrence.pointer} items list requires next_cursor or a named sequence feed`
          : occurrence.field === "$cursor"
            ? `${occurrence.file}: ${occurrence.pointer} non-string cursor needs an exact protocol exception`
            : `${occurrence.file}: ${occurrence.pointer} banned field name ${occurrence.field}`,
      );
    } else {
      applied.add(match);
    }
  }

  list.forEach((alias, index) => {
    if (valid[index] && !applied.has(index))
      problems.push(
        `convention-aliases[${index}]: stale alias for ${alias.file} ${alias.pointer} ${alias.field}`,
      );
  });

  return problems;
}

export async function main() {
  const documents = await loadContracts(
    new URL("../contracts/", import.meta.url),
  );
  let aliases = [];
  try {
    aliases = JSON.parse(
      await readFile(
        new URL("../contracts/common/convention-aliases.json", import.meta.url),
        "utf8",
      ),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const problems = checkConventions(documents, aliases);
  for (const problem of problems) console.log(problem);
  if (problems.length > 0) {
    console.log(`contract conventions: ${problems.length} violation(s)`);
    process.exitCode = 1;
  } else {
    console.log(
      `contract conventions: ${documents.size} documents checked, clean`,
    );
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
