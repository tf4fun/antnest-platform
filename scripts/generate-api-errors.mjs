import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const SCHEMA_PATH = "contracts/common/error.schema.json";
const REGISTRY_PATH = "contracts/common/errors.json";
const SLICES_DIR = "contracts/common/slices";
const REQUIRED_ENVELOPE_FIELDS = [
  "code",
  "category",
  "message",
  "retryable",
  "request_id",
];
const CODE_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const CANONICAL_CATEGORIES = [
  "invalid_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "precondition_failed",
  "rate_limited",
  "unavailable",
  "internal",
];

const SERVICE_OUTPUTS = {
  "admin-console": [
    {
      language: "go",
      path: "services/admin-console/internal/apierror/errors.gen.go",
    },
    {
      language: "typescript",
      path: "services/admin-console/web/src/lib/errors.gen.ts",
    },
  ],
  "agent-acp-service": [
    {
      language: "typescript",
      path: "services/agent-acp-service/src/errors.gen.ts",
    },
  ],
  "agent-controller": [
    {
      language: "go",
      path: "services/agent-controller/internal/apierror/errors.gen.go",
    },
  ],
  "agent-ui": [
    {
      language: "typescript",
      path: "services/agent-ui/web/server/src/errors.gen.ts",
    },
  ],
  "antnest-runtime": [
    {
      language: "rust",
      path: "runtimes/antnest-runtime/src/api_errors_gen.rs",
    },
  ],
  "edge-gateway": [
    {
      language: "go",
      path: "services/edge-gateway/internal/apierror/errors.gen.go",
    },
  ],
  "identity-service": [
    {
      language: "go",
      path: "services/identity-service/internal/apierror/errors.gen.go",
    },
  ],
  "runtime-controller": [
    {
      language: "go",
      path: "services/runtime-controller/internal/apierror/errors.gen.go",
    },
  ],
  "runtime-egress": [
    {
      language: "rust",
      path: "services/runtime-egress/src/api_errors_gen.rs",
    },
  ],
  "skill-registry": [
    {
      language: "go",
      path: "services/skill-registry/internal/apierror/errors.gen.go",
    },
  ],
};

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateRegistry(registry) {
  const problems = [];
  if (!isRecord(registry)) return ["registry is not an object"];
  if (registry.version !== 1)
    problems.push(`version must be 1, got ${JSON.stringify(registry.version)}`);
  if (!Array.isArray(registry.categories) || registry.categories.length === 0)
    problems.push("categories must list the canonical categories");
  else {
    const canonical = new Set(CANONICAL_CATEGORIES);
    const seen = new Set();
    for (const category of registry.categories) {
      if (typeof category !== "string" || !canonical.has(category))
        problems.push(
          `category ${JSON.stringify(category)} is not a canonical category`,
        );
      else if (seen.has(category))
        problems.push(`duplicate category ${category}`);
      else seen.add(category);
    }
    for (const category of canonical)
      if (!seen.has(category))
        problems.push(`canonical category ${category} is missing`);
  }
  if (!Array.isArray(registry.errors) || registry.errors.length === 0) {
    problems.push("errors must be a non-empty array");
    return problems;
  }
  const categories = new Set(
    Array.isArray(registry.categories) ? registry.categories : [],
  );
  const byCode = new Map();
  for (const entry of registry.errors) {
    if (!isRecord(entry)) {
      problems.push("error entry is not an object");
      continue;
    }
    const label =
      typeof entry.code === "string" ? entry.code : JSON.stringify(entry.code);
    if (typeof entry.code !== "string" || !CODE_PATTERN.test(entry.code))
      problems.push(`code ${label} is not snake_case`);
    else if (byCode.has(entry.code))
      problems.push(`duplicate code ${entry.code}`);
    else byCode.set(entry.code, entry);
    if (typeof entry.category !== "string")
      problems.push(`code ${label} is missing a category`);
    else if (!categories.has(entry.category))
      problems.push(`code ${label} uses undeclared category ${entry.category}`);
    if (typeof entry.retryable !== "boolean")
      problems.push(`code ${label} retryable must be a boolean`);
    if (
      !Number.isInteger(entry.http_status) ||
      entry.http_status < 400 ||
      entry.http_status > 599
    )
      problems.push(
        `code ${label} http_status must be an integer between 400 and 599`,
      );
    if (typeof entry.owner !== "string" || entry.owner === "")
      problems.push(`code ${label} is missing a non-empty owner`);
    if (typeof entry.description !== "string" || entry.description === "")
      problems.push(`code ${label} is missing a non-empty description`);
    if (
      entry.deprecated_alias_of !== undefined &&
      typeof entry.deprecated_alias_of !== "string"
    )
      problems.push(`code ${label} alias target must be a code string`);
  }
  const internal = byCode.get("internal");
  if (internal === undefined)
    problems.push("canonical code internal is missing");
  else {
    if (internal.category !== "internal")
      problems.push("code internal must use the internal category");
    if (internal.retryable !== false)
      problems.push("code internal retryable must be false");
    if (internal.http_status !== 500)
      problems.push("code internal http_status must be 500");
  }
  for (const entry of registry.errors) {
    if (!isRecord(entry)) continue;
    const alias = entry.deprecated_alias_of;
    if (alias === undefined || typeof alias !== "string") continue;
    if (alias === entry.code) {
      problems.push(`code ${entry.code} alias targets itself`);
      continue;
    }
    const target = byCode.get(alias);
    if (target === undefined) {
      problems.push(
        `code ${entry.code} alias target ${alias} is not registered`,
      );
      continue;
    }
    if (target.deprecated_alias_of !== undefined)
      problems.push(
        `code ${entry.code} alias target ${alias} is itself an alias`,
      );
    if (target.category !== entry.category)
      problems.push(
        `code ${entry.code} alias category ${entry.category} differs from target ${alias} category ${target.category}`,
      );
  }
  return problems;
}

function goConstant(code) {
  return code
    .split("_")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

const upperSnake = (code) => code.toUpperCase();

function selectEntries(registry, codes) {
  const problems = validateRegistry(registry);
  if (problems.length > 0)
    throw new Error(`invalid registry:\n${problems.join("\n")}`);
  const byCode = new Map(registry.errors.map((entry) => [entry.code, entry]));
  const internal = byCode.get("internal");
  if (internal === undefined)
    throw new Error("registry does not declare the canonical internal code");
  const selected = [];
  const seen = new Set();
  for (const code of codes) {
    const entry = byCode.get(code);
    if (entry === undefined)
      throw new Error(
        `code ${JSON.stringify(code)} is not declared in the registry`,
      );
    if (seen.has(code)) continue;
    seen.add(code);
    selected.push(entry);
  }
  if (!seen.has("internal")) selected.push(internal);
  return selected;
}

const GO_RUNTIME = `type Error struct {
\tCode      string         \`json:"code"\`
\tCategory  string         \`json:"category"\`
\tMessage   string         \`json:"message"\`
\tRetryable bool           \`json:"retryable"\`
\tRequestID string         \`json:"request_id"\`
\tDetails   map[string]any \`json:"details,omitempty"\`
}

func New(code, message, requestID string) Error {
\tmeta, ok := metadata[code]
\tif !ok {
\t\tcode = Internal
\t\tmeta = metadata[Internal]
\t\tmessage = "Internal service error"
\t}
\tif !validRequestID(requestID) {
\t\trequestID = randomRequestID()
\t}
\treturn Error{
\t\tCode:      code,
\t\tCategory:  meta.Category,
\t\tMessage:   message,
\t\tRetryable: meta.Retryable,
\t\tRequestID: requestID,
\t}
}

func WriteError(w http.ResponseWriter, status int, code, message string, retryable bool) {
\trequestID := w.Header().Get("X-Request-ID")
\tif !validRequestID(requestID) {
\t\trequestID = randomRequestID()
\t\tw.Header().Set("X-Request-ID", requestID)
\t}
\tenvelope := New(code, message, requestID)
\tif _, ok := metadata[code]; ok {
\t\tenvelope.Retryable = retryable
\t}
\tw.Header().Set("Content-Type", "application/json")
\tw.Header().Set("Cache-Control", "no-store")
\tw.WriteHeader(status)
\t_ = json.NewEncoder(w).Encode(envelope)
}

func validRequestID(requestID string) bool {
\tif requestID == "" || len(requestID) > 128 {
\t\treturn false
\t}
\tfor i := 0; i < len(requestID); i++ {
\t\tc := requestID[i]
\t\tif !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == ':' || c == '-') {
\t\t\treturn false
\t\t}
\t}
\treturn true
}

func randomRequestID() string {
\tvar b [16]byte
\tif _, err := rand.Read(b[:]); err == nil {
\t\treturn hex.EncodeToString(b[:])
\t}
\treturn "req-" + strconv.FormatInt(time.Now().UnixNano(), 16)
}`;

export function renderGo(registry, codes) {
  const entries = selectEntries(registry, codes);
  const lines = [
    "package apierror",
    "",
    "import (",
    '\t"crypto/rand"',
    '\t"encoding/hex"',
    '\t"encoding/json"',
    '\t"net/http"',
    '\t"strconv"',
    '\t"time"',
    ")",
    "",
    "const (",
    ...entries.map((entry) => `\t${goConstant(entry.code)} = "${entry.code}"`),
    ")",
    "",
    "type Metadata struct {",
    "\tCategory   string",
    "\tHTTPStatus int",
    "\tRetryable  bool",
    "}",
    "",
    "var metadata = map[string]Metadata{",
    ...entries.map(
      (entry) =>
        `\t${goConstant(entry.code)}: {Category: "${entry.category}", HTTPStatus: ${entry.http_status}, Retryable: ${entry.retryable}},`,
    ),
    "}",
    "",
    GO_RUNTIME,
  ];
  const source = `${lines.join("\n")}\n`;
  const formatted = spawnSync("gofmt", [], {
    input: source,
    encoding: "utf8",
  });
  if (formatted.error !== undefined)
    throw new Error(
      `gofmt is required to render Go output: ${formatted.error.message}`,
    );
  if (formatted.status !== 0)
    throw new Error(
      `gofmt rejected the generated Go source:\n${formatted.stderr}`,
    );
  return formatted.stdout;
}

export function renderTypeScript(registry, codes) {
  const entries = selectEntries(registry, codes);
  const internal = entries.find((entry) => entry.code === "internal");
  const metadataLines = entries.flatMap((entry) => {
    const single = `  ${entry.code}: { category: "${entry.category}", httpStatus: ${entry.http_status}, retryable: ${entry.retryable} },`;
    if (single.length <= 100) return [single];
    return [
      `  ${entry.code}: {`,
      `    category: "${entry.category}",`,
      `    httpStatus: ${entry.http_status},`,
      `    retryable: ${entry.retryable},`,
      "  },",
    ];
  });
  const lines = [
    "export const ERROR_CODES = {",
    ...entries.map((entry) => `  ${upperSnake(entry.code)}: "${entry.code}",`),
    "} as const;",
    "",
    "export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];",
    "",
    "export const ERROR_METADATA: Record<",
    "  string,",
    "  { category: string; httpStatus: number; retryable: boolean }",
    "> = {",
    ...metadataLines,
    "};",
    "",
    "export type ApiError = {",
    "  code: string;",
    "  category: string;",
    "  message: string;",
    "  retryable: boolean;",
    "  request_id: string;",
    "  details?: Record<string, unknown>;",
    "};",
    "",
    "const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;",
    "",
    "function requestIdOrDefault(requestId: string): string {",
    "  if (REQUEST_ID_PATTERN.test(requestId)) return requestId;",
    "  return globalThis.crypto.randomUUID();",
    "}",
    "",
    "export function createError(code: string, message: string, requestId: string): ApiError {",
    "  const meta = Object.hasOwn(ERROR_METADATA, code) ? ERROR_METADATA[code] : undefined;",
    "  if (meta === undefined) {",
    "    return {",
    "      code: ERROR_CODES.INTERNAL,",
    `      category: "${internal.category}",`,
    '      message: "Internal service error",',
    "      retryable: false,",
    "      request_id: requestIdOrDefault(requestId),",
    "    };",
    "  }",
    "  return {",
    "    code,",
    "    category: meta.category,",
    "    message,",
    "    retryable: meta.retryable,",
    "    request_id: requestIdOrDefault(requestId),",
    "  };",
    "}",
  ];
  return `${lines.join("\n")}\n`;
}

export function renderRust(registry, codes) {
  const entries = selectEntries(registry, codes);
  const internal = entries.find((entry) => entry.code === "internal");
  const lines = [
    ...entries.map(
      (entry) => `pub const ${upperSnake(entry.code)}: &str = "${entry.code}";`,
    ),
    "",
    "pub struct ErrorMetadata {",
    "    pub category: &'static str,",
    "    pub http_status: u16,",
    "    pub retryable: bool,",
    "}",
    "",
    "pub fn metadata(code: &str) -> Option<ErrorMetadata> {",
    "    match code {",
    ...entries.flatMap((entry) => [
      `        "${entry.code}" => Some(ErrorMetadata {`,
      `            category: "${entry.category}",`,
      `            http_status: ${entry.http_status},`,
      `            retryable: ${entry.retryable},`,
      "        }),",
    ]),
    "        _ => None,",
    "    }",
    "}",
    "",
    "fn valid_request_id(request_id: &str) -> bool {",
    "    !request_id.is_empty()",
    "        && request_id.len() <= 128",
    "        && request_id",
    "            .bytes()",
    "            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))",
    "}",
    "",
    "fn generated_request_id() -> String {",
    "    use std::sync::atomic::{AtomicU64, Ordering};",
    "    use std::time::{SystemTime, UNIX_EPOCH};",
    "    static COUNTER: AtomicU64 = AtomicU64::new(0);",
    "    let nanos = SystemTime::now()",
    "        .duration_since(UNIX_EPOCH)",
    "        .map(|duration| duration.as_nanos())",
    "        .unwrap_or(0);",
    "    format!(",
    '        "gen-{:x}-{:x}",',
    "        nanos,",
    "        COUNTER.fetch_add(1, Ordering::Relaxed)",
    "    )",
    "}",
    "",
    "pub(crate) fn envelope(",
    "    code: &str,",
    "    message: &str,",
    "    request_id: &str,",
    "    retryable: bool,",
    ") -> serde_json::Value {",
    "    let (code, category, message, retryable) = match metadata(code) {",
    "        Some(meta) => (code, meta.category, message.to_owned(), retryable),",
    "        None => (",
    "            INTERNAL,",
    `            "${internal.category}",`,
    '            "Internal service error".to_owned(),',
    "            false,",
    "        ),",
    "    };",
    "    let request_id = if valid_request_id(request_id) {",
    "        request_id.to_owned()",
    "    } else {",
    "        generated_request_id()",
    "    };",
    "    serde_json::json!({",
    '        "code": code,',
    '        "category": category,',
    '        "message": message,',
    '        "retryable": retryable,',
    '        "request_id": request_id,',
    "    })",
    "}",
  ];
  return `${lines.join("\n")}\n`;
}

const RENDERERS = {
  go: renderGo,
  typescript: renderTypeScript,
  rust: renderRust,
};

function readJSON(relative) {
  return JSON.parse(readFileSync(join(root, relative), "utf8"));
}

function loadContracts() {
  const problems = [];
  let schema;
  let registry;
  try {
    schema = readJSON(SCHEMA_PATH);
  } catch (error) {
    problems.push(`${SCHEMA_PATH}: ${error.message}`);
  }
  try {
    registry = readJSON(REGISTRY_PATH);
  } catch (error) {
    problems.push(`${REGISTRY_PATH}: ${error.message}`);
  }
  return { schema, registry, problems };
}

function validateSchemaBasics(schema, registry) {
  const problems = [];
  if (!isRecord(schema)) return [`${SCHEMA_PATH} is not an object`];
  if (schema.type !== "object")
    problems.push(`${SCHEMA_PATH}: type must be object`);
  if (!Array.isArray(schema.required))
    problems.push(`${SCHEMA_PATH}: required must be an array`);
  else
    for (const field of REQUIRED_ENVELOPE_FIELDS)
      if (!schema.required.includes(field))
        problems.push(`${SCHEMA_PATH}: required is missing ${field}`);
  if (schema.additionalProperties === false)
    problems.push(`${SCHEMA_PATH}: additionalProperties must stay permitted`);
  const enumValues = schema.properties?.category?.enum;
  if (!Array.isArray(enumValues))
    problems.push(`${SCHEMA_PATH}: category enum is missing`);
  else if (isRecord(registry) && Array.isArray(registry.categories)) {
    const sort = (values) => [...values].sort();
    if (
      JSON.stringify(sort(enumValues)) !==
      JSON.stringify(sort(registry.categories))
    )
      problems.push(
        `${SCHEMA_PATH}: category enum does not match registry categories`,
      );
  }
  return problems;
}

function sliceNames() {
  const directory = join(root, SLICES_DIR);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

function validateSlice(name, slice, registry) {
  const problems = [];
  if (!isRecord(slice)) return [`slice ${name} is not an object`];
  if (slice.service !== name)
    problems.push(`slice ${name}: service must be ${JSON.stringify(name)}`);
  if (!Array.isArray(slice.codes) || slice.codes.length === 0) {
    problems.push(`slice ${name}: codes must be a non-empty array`);
    return problems;
  }
  const declared = new Set(registry.errors.map((entry) => entry.code));
  const seen = new Set();
  for (const code of slice.codes) {
    if (typeof code !== "string" || !declared.has(code))
      problems.push(
        `slice ${name}: code ${JSON.stringify(code)} is not registered`,
      );
    else if (seen.has(code))
      problems.push(`slice ${name}: duplicate code ${code}`);
    else seen.add(code);
  }
  return problems;
}

function loadSlice(name) {
  const relative = `${SLICES_DIR}/${name}.json`;
  if (!existsSync(join(root, relative)))
    throw new Error(`${relative} is not checked in`);
  return readJSON(relative);
}

function sliceProblems(name, registry) {
  let slice;
  try {
    slice = loadSlice(name);
  } catch (error) {
    return { problems: [error.message] };
  }
  return { slice, problems: validateSlice(name, slice, registry) };
}

function checkSlices(onlyService, registry) {
  const problems = [];
  for (const name of sliceNames()) {
    if (onlyService !== undefined && name !== onlyService) continue;
    const { slice, problems: found } = sliceProblems(name, registry);
    problems.push(...found);
    if (found.length > 0) continue;
    const outputs = SERVICE_OUTPUTS[name];
    if (outputs === undefined) {
      problems.push(`slice ${name} has no output mapping`);
      continue;
    }
    for (const output of outputs) {
      const expected = RENDERERS[output.language](registry, slice.codes);
      const path = join(root, output.path);
      if (!existsSync(path)) {
        problems.push(
          `${output.path} is missing; run scripts/generate-api-errors.mjs --service ${name}`,
        );
        continue;
      }
      if (readFileSync(path, "utf8") !== expected)
        problems.push(
          `${output.path} is stale; run scripts/generate-api-errors.mjs --service ${name}`,
        );
    }
  }
  return problems;
}

function generateService(name, registry) {
  const { slice, problems } = sliceProblems(name, registry);
  if (problems.length > 0) return problems;
  const outputs = SERVICE_OUTPUTS[name];
  if (outputs === undefined) return [`slice ${name} has no output mapping`];
  for (const output of outputs) {
    const text = RENDERERS[output.language](registry, slice.codes);
    const path = join(root, output.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    console.log(`wrote ${output.path}`);
  }
  return [];
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const all = args.includes("--all");
  let service;
  let serviceFlag = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "--service") continue;
    serviceFlag = true;
    const value = args[index + 1];
    if (value !== undefined && !value.startsWith("--")) {
      service = value;
      index++;
    }
  }
  const problems = [];
  if (
    (!check && !all && !serviceFlag) ||
    (serviceFlag && service === undefined)
  ) {
    console.error(
      "usage: generate-api-errors.mjs --check [--service <name>] | --service <name> | --all",
    );
    process.exitCode = 2;
  } else {
    const { schema, registry, problems: loadProblems } = loadContracts();
    problems.push(...loadProblems);
    if (registry !== undefined) problems.push(...validateRegistry(registry));
    if (schema !== undefined)
      problems.push(...validateSchemaBasics(schema, registry));
    if (problems.length === 0) {
      if (service !== undefined) {
        if (SERVICE_OUTPUTS[service] === undefined)
          problems.push(`unknown service ${JSON.stringify(service)}`);
        else if (!existsSync(join(root, `${SLICES_DIR}/${service}.json`)))
          problems.push(`${SLICES_DIR}/${service}.json is not checked in`);
        else if (check) problems.push(...checkSlices(service, registry));
        else problems.push(...generateService(service, registry));
      } else if (check) problems.push(...checkSlices(undefined, registry));
      else
        for (const name of sliceNames())
          problems.push(...generateService(name, registry));
    }
    for (const problem of problems) console.error(problem);
    if (problems.length > 0) process.exitCode = 1;
    else if (check) console.log("common api error contracts are consistent");
  }
}
