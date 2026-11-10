const SCHEMA_VERSION = 1;
const NAME_PATTERN = /^antnest\.[a-z0-9_]+(?:\.[a-z0-9_]+)*$/;
const LEGACY_METRIC_PATTERN = /^antnest_[a-z0-9_]+$/;

const nameIsValid = (entry) =>
  NAME_PATTERN.test(entry.name) ||
  (entry.kind === "metric" &&
    entry.legacy_metric_name === true &&
    LEGACY_METRIC_PATTERN.test(entry.name));
const SYMBOL_PATTERN = /^[A-Z0-9]+(?:_[A-Z0-9]+)*$/;
const KINDS = ["span_attribute", "metric", "event"];
const TYPES = ["string", "int", "double", "boolean", "string[]"];
const CARDINALITIES = ["low", "bounded", "unbounded"];
const PII_LEVELS = ["none", "identifier", "content"];
const SERVICES = [
  "admin-console",
  "agent-acp-service",
  "agent-controller",
  "agent-ui",
  "antnest-runtime",
  "edge-gateway",
  "identity-service",
  "runtime-controller",
  "runtime-egress",
  "skill-registry",
];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const entryName = (entry) =>
  typeof entry.name === "string" ? entry.name : JSON.stringify(entry.name);

const upperSymbol = (name) => name.toUpperCase().replace(/\./g, "_");

export const entrySymbol = (entry) =>
  typeof entry.symbol === "string"
    ? entry.symbol
    : upperSymbol(entry.name) +
      (typeof entry.deprecated_alias_of === "string" ? "_LEGACY" : "");

export const pascalSymbol = (symbol) =>
  symbol
    .split("_")
    .filter((part) => part !== "")
    .map((part) => part[0] + part.slice(1).toLowerCase())
    .join("");

export const restrictedMetricAttribute = (entry) =>
  entry.kind === "span_attribute" &&
  (entry.cardinality === "unbounded" || entry.pii === "content");

function validateEnumList(entry, field, allowed, primary) {
  const problems = [];
  const name = entryName(entry);
  const values = entry[field];
  if (values === undefined) return problems;
  if (!Array.isArray(values) || values.length === 0) {
    problems.push(`attribute ${name} ${field} must be a non-empty array`);
    return problems;
  }
  const seen = new Set();
  for (const value of values)
    if (typeof value !== "string" || !allowed.includes(value))
      problems.push(
        `attribute ${name} ${field} value ${JSON.stringify(value)} is not a known value`,
      );
    else if (value === primary)
      problems.push(
        `attribute ${name} ${field} repeats the primary ${field === "alternate_types" ? "type" : "kind"} ${value}`,
      );
    else if (seen.has(value))
      problems.push(`attribute ${name} ${field} duplicates ${value}`);
    else seen.add(value);
  return problems;
}

export function validateRegistry(registry) {
  const problems = [];
  if (!isRecord(registry)) return ["registry is not an object"];
  if (registry.schema_version !== SCHEMA_VERSION)
    problems.push(
      `schema_version must be ${SCHEMA_VERSION}, got ${JSON.stringify(registry.schema_version)}`,
    );
  if (registry.namespace_literals !== undefined) {
    if (!isRecord(registry.namespace_literals))
      problems.push("namespace_literals must be an object");
    else
      for (const [literal, reason] of Object.entries(
        registry.namespace_literals,
      )) {
        if (!literal.startsWith("antnest."))
          problems.push(
            `namespace_literals key ${JSON.stringify(literal)} must be an antnest.* literal`,
          );
        if (typeof reason !== "string" || reason === "")
          problems.push(
            `namespace_literals ${literal} needs a non-empty reason`,
          );
      }
  }
  if (!Array.isArray(registry.attributes) || registry.attributes.length === 0) {
    problems.push("attributes must be a non-empty array");
    return problems;
  }
  const services = new Set(SERVICES);
  const byName = new Map();
  for (const entry of registry.attributes) {
    if (!isRecord(entry)) {
      problems.push("attribute entry is not an object");
      continue;
    }
    const name = entryName(entry);
    if (typeof entry.name !== "string" || !nameIsValid(entry))
      problems.push(`attribute name ${name} is not a dotted antnest.* name`);
    else if (byName.has(entry.name))
      problems.push(`duplicate attribute name ${entry.name}`);
    else byName.set(entry.name, entry);
    if (typeof entry.kind !== "string" || !KINDS.includes(entry.kind))
      problems.push(`attribute ${name} kind is not one of ${KINDS.join(", ")}`);
    if (typeof entry.type !== "string" || !TYPES.includes(entry.type))
      problems.push(`attribute ${name} type is not one of ${TYPES.join(", ")}`);
    if (
      typeof entry.cardinality !== "string" ||
      !CARDINALITIES.includes(entry.cardinality)
    )
      problems.push(
        `attribute ${name} cardinality is not one of ${CARDINALITIES.join(", ")}`,
      );
    if (typeof entry.pii !== "string" || !PII_LEVELS.includes(entry.pii))
      problems.push(
        `attribute ${name} pii is not one of ${PII_LEVELS.join(", ")}`,
      );
    if (!Array.isArray(entry.owner) || entry.owner.length === 0)
      problems.push(`attribute ${name} needs a non-empty owner array`);
    else {
      const seen = new Set();
      for (const owner of entry.owner)
        if (typeof owner !== "string" || !services.has(owner))
          problems.push(
            `attribute ${name} owner ${JSON.stringify(owner)} is not a known service`,
          );
        else if (seen.has(owner))
          problems.push(`attribute ${name} owner ${owner} is duplicated`);
        else seen.add(owner);
    }
    if (
      entry.unit !== undefined &&
      (typeof entry.unit !== "string" || entry.unit === "")
    )
      problems.push(`attribute ${name} unit must be a non-empty string`);
    if (
      entry.kind === "metric" &&
      (typeof entry.unit !== "string" || entry.unit === "")
    )
      problems.push(`metric ${name} requires a unit`);
    if (
      entry.symbol !== undefined &&
      (typeof entry.symbol !== "string" || !SYMBOL_PATTERN.test(entry.symbol))
    )
      problems.push(`attribute ${name} symbol must be UPPER_SNAKE`);
    if (entry.labels !== undefined && entry.kind !== "metric")
      problems.push(`attribute ${name} labels are only allowed on metrics`);
    if (entry.labels !== undefined && !Array.isArray(entry.labels))
      problems.push(`metric ${name} labels must be an array`);
    problems.push(
      ...validateEnumList(entry, "alternate_types", TYPES, entry.type),
      ...validateEnumList(entry, "additional_kinds", KINDS, entry.kind),
    );
  }
  for (const entry of registry.attributes) {
    if (!isRecord(entry)) continue;
    const alias = entry.deprecated_alias_of;
    if (alias === undefined) continue;
    const name = entryName(entry);
    if (typeof alias !== "string") {
      problems.push(`attribute ${name} alias target must be a name string`);
      continue;
    }
    if (alias === entry.name) {
      problems.push(`attribute ${name} alias targets itself`);
      continue;
    }
    const target = byName.get(alias);
    if (target === undefined) {
      problems.push(
        `attribute ${name} alias target ${alias} is not registered`,
      );
      continue;
    }
    if (target.deprecated_alias_of !== undefined)
      problems.push(
        `attribute ${name} alias target ${alias} is itself an alias`,
      );
    for (const field of ["kind", "type", "unit", "cardinality", "pii"])
      if (target[field] !== entry[field])
        problems.push(
          `attribute ${name} alias ${field} ${JSON.stringify(entry[field])} differs from target ${alias} ${field} ${JSON.stringify(target[field])}`,
        );
    const sortedList = (values) => JSON.stringify([...(values ?? [])].sort());
    if (
      sortedList(entry.alternate_types) !== sortedList(target.alternate_types)
    )
      problems.push(
        `attribute ${name} alias alternate_types differ from target ${alias}`,
      );
  }
  for (const entry of registry.attributes) {
    if (!isRecord(entry) || !Array.isArray(entry.labels)) continue;
    const name = entryName(entry);
    const seen = new Set();
    for (const labelName of entry.labels) {
      const target = byName.get(labelName);
      if (typeof labelName !== "string" || target === undefined)
        problems.push(
          `metric ${name} label ${JSON.stringify(labelName)} is not a registered attribute`,
        );
      else if (seen.has(labelName))
        problems.push(`metric ${name} label ${labelName} is duplicated`);
      else {
        seen.add(labelName);
        if (target.kind !== "span_attribute")
          problems.push(
            `metric ${name} label ${labelName} is not a span attribute`,
          );
        if (target.cardinality === "unbounded")
          problems.push(
            `metric ${name} label ${labelName} has unbounded cardinality`,
          );
        if (target.pii === "content")
          problems.push(`metric ${name} label ${labelName} captures content`);
      }
    }
  }
  const bySymbol = new Map();
  for (const entry of registry.attributes) {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      !nameIsValid(entry)
    )
      continue;
    const symbol = entrySymbol(entry);
    const previous = bySymbol.get(symbol);
    if (previous !== undefined)
      problems.push(
        `attributes ${previous} and ${entry.name} generate the same symbol ${symbol}`,
      );
    else bySymbol.set(symbol, entry.name);
  }
  return problems;
}

function selectEntries(registry) {
  const problems = validateRegistry(registry);
  if (problems.length > 0)
    throw new Error(`invalid registry:\n${problems.join("\n")}`);
  return [...registry.attributes].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

export function renderGo(registry) {
  const entries = selectEntries(registry);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const lines = [
    "package telemetry",
    "",
    ...entries.map(
      (entry) => `const ${pascalSymbol(entrySymbol(entry))} = "${entry.name}"`,
    ),
    "",
    "var DeprecatedAliases = func() map[string]string {",
    "\tvalues := map[string]string{}",
    ...entries
      .filter((entry) => typeof entry.deprecated_alias_of === "string")
      .map(
        (entry) =>
          `\tvalues[${pascalSymbol(entrySymbol(entry))}] = ${pascalSymbol(entrySymbol(byName.get(entry.deprecated_alias_of)))}`,
      ),
    "\treturn values",
    "}()",
    "",
    "var RestrictedMetricAttributes = func() map[string]bool {",
    "\tvalues := map[string]bool{}",
    ...entries
      .filter(restrictedMetricAttribute)
      .map((entry) => `\tvalues[${pascalSymbol(entrySymbol(entry))}] = true`),
    "\treturn values",
    "}()",
    "",
  ];
  return lines.join("\n");
}

export function renderTypeScript(registry) {
  const entries = selectEntries(registry);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const lines = [
    "export const SEMCONV = {",
    ...entries.map((entry) => `  ${entrySymbol(entry)}: "${entry.name}",`),
    "} as const;",
    "",
    "export const DEPRECATED_ALIASES: Record<string, string> = {",
    ...entries
      .filter((entry) => typeof entry.deprecated_alias_of === "string")
      .map(
        (entry) =>
          `  [SEMCONV.${entrySymbol(entry)}]: SEMCONV.${entrySymbol(byName.get(entry.deprecated_alias_of))},`,
      ),
    "};",
    "",
    "export const RESTRICTED_METRIC_ATTRIBUTES: ReadonlySet<string> = new Set([",
    ...entries
      .filter(restrictedMetricAttribute)
      .map((entry) => `  SEMCONV.${entrySymbol(entry)},`),
    "]);",
    "",
  ];
  return lines.join("\n");
}

export function renderRust(registry) {
  const entries = selectEntries(registry);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const lines = [
    "#![allow(dead_code)]",
    "",
    ...entries.map(
      (entry) => `pub const ${entrySymbol(entry)}: &str = "${entry.name}";`,
    ),
    "",
    "pub const DEPRECATED_ALIASES: &[(&str, &str)] = &[",
    ...entries
      .filter((entry) => typeof entry.deprecated_alias_of === "string")
      .map(
        (entry) =>
          `    (${entrySymbol(entry)}, ${entrySymbol(byName.get(entry.deprecated_alias_of))}),`,
      ),
    "];",
    "",
    "pub const RESTRICTED_METRIC_ATTRIBUTES: &[&str] = &[",
    ...entries
      .filter(restrictedMetricAttribute)
      .map((entry) => `    ${entrySymbol(entry)},`),
    "];",
    "",
  ];
  return lines.join("\n");
}

export function renderMarkdown(registry) {
  const entries = selectEntries(registry);
  const kindOf = (entry) =>
    [entry.kind, ...(entry.additional_kinds ?? [])].join(", ");
  const typeOf = (entry) =>
    [entry.type, ...(entry.alternate_types ?? [])].join(", ");
  const lines = [
    "| name | kind | type | unit | cardinality | pii | owner | labels | deprecated_alias_of |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...entries.map(
      (entry) =>
        `| ${entry.name} | ${kindOf(entry)} | ${typeOf(entry)} | ${entry.unit ?? ""} | ${entry.cardinality} | ${entry.pii} | ${entry.owner.join(", ")} | ${(entry.labels ?? []).join(", ")} | ${entry.deprecated_alias_of ?? ""} |`,
    ),
    "",
  ];
  return lines.join("\n");
}
