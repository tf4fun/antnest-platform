import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  checkTrustedHeaders,
  collectHeaderSources,
} from "./check-trusted-headers.mjs";

const registry = JSON.parse(
  readFileSync(
    new URL(
      "../../contracts/edge-gateway/request-headers.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function inspect(path, source, options = {}) {
  return checkTrustedHeaders({
    sources: { [path]: source },
    registry,
    nonHeaders: [],
    ...options,
  });
}

test("registered header aliases are inventoried at their production definitions", () => {
  const sources = {
    "modules/auth/header.go":
      'const Header = "Antnest-Service-Authorization"\nfunc read(h http.Header) { h.Get(Header) }',
    "services/browser/header.tsx":
      'const AUTH = "x-antnest-csrf-token"; fetch("/", {headers: {[AUTH]: value}});',
    "runtimes/core/src/header.rs":
      'const FENCE: &str = r#"X-Antnest-Expected-Execution-ID"#; request.headers().get(FENCE);',
  };
  const result = checkTrustedHeaders({ sources, registry, nonHeaders: [] });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.headers.sort(), [
    "antnest-service-authorization",
    "x-antnest-csrf-token",
    "x-antnest-expected-execution-id",
  ]);
});

for (const [path, source] of [
  ["services/gateway/header.go", 'const Future = "X-Antnest-Future-Authority"'],
  ["services/browser/header.tsx", 'const Future = "aNtNeSt-Future-Authority";'],
  [
    "runtimes/core/src/header.rs",
    'const FUTURE: &str = r##"x-antnest-future-authority"##;',
  ],
  [
    "services/alias/header.ts",
    'const Future = "X-Antnest-Future-Authority"; headers.get(Future);',
  ],
]) {
  test(`unregistered production header fails admission: ${path}`, () => {
    const result = inspect(path, source);
    assert(
      result.errors.some(
        (message) =>
          message.includes(path) &&
          message.toLowerCase().includes("future-authority"),
      ),
    );
  });
}

test("comments, unrelated substrings and Rust test modules do not add production names", () => {
  const source = `
    // "X-Antnest-Comment-Only"
    /* outer /* nested "Antnest-Nested-Comment" */ comment */
    const REAL: &str = "X-Antnest-Agent-ID";
    const LOG: &str = "reject X-Antnest-Log-Only";
    #[cfg(test)]
    mod tests {
      const TEST: &str = "X-Antnest-Test-Only";
      fn nested() { let _ = "}"; }
    }
    const AFTER: &str = "Antnest-Caller-Context";
  `;
  const result = inspect("runtimes/core/src/header.rs", source);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.headers.sort(), [
    "antnest-caller-context",
    "x-antnest-agent-id",
  ]);
});

test("escaped names are checked after decoding string values", () => {
  const result = inspect(
    "services/browser/header.ts",
    'const name = "X-Antnest-\\u0046uture-Authority";',
  );
  assert(
    result.errors.some((message) =>
      message.toLowerCase().includes("future-authority"),
    ),
  );
});

test("Rust module-local inner test attributes cannot hide production siblings", () => {
  const result = inspect(
    "runtimes/core/src/header.rs",
    `
    mod test_only {
      #![cfg(test)]
      const TEST: &str = "Antnest-Test-Only";
    }
    const FUTURE: &str = "Antnest-Future-Authority";
  `,
  );
  assert.equal(result.errors.length, 1);
  assert(result.errors[0].includes("Antnest-Future-Authority"));
});

test("Rust crate-level inner test attributes exclude that test crate", () => {
  const result = inspect(
    "runtimes/core/src/probe.rs",
    `
    // An independent test-only crate.
    #![cfg(test)]
    const TEST: &str = "Antnest-Test-Only";
  `,
  );
  assert.deepEqual(result.errors, []);
});

for (const [name, source] of [
  [
    "match arm",
    `fn name(mode: u8) -> &'static str { match mode {
      #[cfg(test)] 1 => "Antnest-Test-Only",
      _ => "Antnest-Future-Authority",
    } }`,
  ],
  [
    "final match arm",
    `fn name(mode: u8) -> &'static str { match mode {
      #[cfg(test)] _ => "Antnest-Test-Only"
    } }
    const NEXT: &str = "Antnest-Future-Authority";`,
  ],
  [
    "enum variant with nested arguments",
    `enum Label {
      #[cfg(test)] Test = length("Antnest-Test-Only", 0),
      Production = length("Antnest-Future-Authority", 1),
    }`,
  ],
]) {
  test(`Rust outer test attribute excludes only its ${name}`, () => {
    const result = inspect("runtimes/core/src/header.rs", source);
    assert.equal(result.errors.length, 1);
    assert(result.errors[0].includes("Antnest-Future-Authority"));
  });
}

for (const [name, source] of [
  ["plain JSX", '<Header name="X-Antnest-Future-Authority" />'],
  ["decimal JSX entity", '<Header name="&#88;-Antnest-Future-Authority" />'],
  ["hex JSX entity", '<Header name="&#x58;-Antnest-Future-Authority" />'],
  ["JavaScript escape", '"\\u0058-Antnest-Future-Authority"'],
  ["static template escape", "`\\u0058-Antnest-Future-Authority`"],
]) {
  test(`${name} is checked with its runtime string value`, () => {
    const result = inspect(
      "services/browser/header.tsx",
      `const h = ${source};`,
    );
    assert.equal(result.errors.length, 1);
    assert(result.errors[0].includes("X-Antnest-Future-Authority"));
  });
}

test("JavaScript strings preserve entities and JSX strings preserve backslashes", () => {
  for (const source of [
    'const h = "&#88;-Antnest-Future-Authority";',
    "const h = `&#x58;-Antnest-Future-Authority`;",
    'const h = <Header name="\\u0058-Antnest-Future-Authority" />;',
    'const h = <Header name="&amp;#88;-Antnest-Future-Authority" />;',
  ])
    assert.deepEqual(inspect("services/browser/header.tsx", source).errors, []);
});

test("dynamic exceptions require both the reviewed template type and source", () => {
  const path = "services/multipart/boundary.ts";
  const nonHeaders = [
    {
      value: "antnest-skill-${seed}",
      template: true,
      purpose: "multipart boundary template",
      source: path,
    },
  ];
  const template = "const boundary = `antnest-skill-${seed}`;";
  assert.deepEqual(inspect(path, template, { nonHeaders }).errors, []);
  assert.equal(
    inspect("services/other/boundary.ts", template, { nonHeaders }).errors
      .length,
    1,
  );
  for (const source of [
    'const boundary = "antnest-skill-${seed}";',
    "const boundary = `antnest-skill-\\${seed}`;",
  ]) {
    assert.equal(inspect(path, source, { nonHeaders }).errors.length, 1);
    assert.equal(
      inspect("services/other/boundary.ts", source, { nonHeaders }).errors
        .length,
      1,
    );
  }
});

test("non-header vocabulary is exact and cannot exempt a whole prefix", () => {
  const nonHeaders = [
    {
      value: "antnest-runtime",
      purpose: "workload identity",
      source: "modules/auth/header.go",
    },
  ];
  assert.deepEqual(
    inspect("modules/auth/header.go", 'const Name = "antnest-runtime"', {
      nonHeaders,
    }).errors,
    [],
  );
  assert(
    inspect(
      "modules/auth/header.go",
      'const Name = "antnest-runtime-new-authorization"',
      { nonHeaders },
    ).errors.length > 0,
  );
});

test("a registered header cannot also be exempted as non-header vocabulary", () => {
  const result = inspect(
    "modules/auth/header.go",
    'const Header = "Antnest-Caller-Context"',
    {
      nonHeaders: [
        {
          value: "Antnest-Caller-Context",
          purpose: "invalid exception",
          source: "modules/auth/header.go",
        },
      ],
    },
  );
  assert(
    result.errors.some((message) =>
      /both|overlap|header.*exception/i.test(message),
    ),
  );
});

test("dynamic reserved names require an explicit inventory decision", () => {
  assert(
    inspect("services/browser/header.ts", "const name = `X-Antnest-${role}`;")
      .errors.length > 0,
  );
  assert(
    inspect("services/browser/header.ts", 'const name = "X-Antnest-" + role;')
      .errors.length > 0,
  );
});

test("production collection includes every service, runtime, shared module and browser TSX", () => {
  const sources = collectHeaderSources();
  for (const path of [
    "modules/service-authentication/callercontext/verification.go",
    "services/admin-console/web/src/App.tsx",
    "services/agent-ui/web/server/src/adapters/caller-context.ts",
    "runtimes/antnest-runtime/src/mcp.rs",
  ])
    assert(path in sources, `missing production source ${path}`);
  assert(
    !Object.keys(sources).some((path) =>
      /(?:_test\.go|_tests\.rs|\.test\.[cm]?[jt]sx?$|\/node_modules\/|\/target\/)/u.test(
        path,
      ),
    ),
  );
});

test("current repository reserved vocabulary is fully registered", () => {
  const result = checkTrustedHeaders();
  assert.deepEqual(result.errors, []);
  assert.equal(result.headers.length, registry.headers.length);
});
