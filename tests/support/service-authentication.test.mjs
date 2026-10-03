import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

async function checker() {
  const file = new URL("./check-service-authentication.mjs", import.meta.url);
  assert(existsSync(file), "missing route caller coverage check");
  return import(file.href);
}

test("every currently registered service route has an explicit caller policy", async () => {
  const { checkRepository } = await checker();
  const result = await checkRepository();
  assert.deepEqual(result.errors, []);
  assert.equal(result.services, 10);
  assert(result.routes > 200);
});

test("removing a caller declaration from a real route fails admission", async () => {
  const { checkRepository } = await checker();
  const result = await checkRepository({
    transformPolicy(service, policy) {
      if (service === "identity-service")
        delete policy.routes["POST /rpc/identity/create-local-user"].callers;
      return policy;
    },
  });
  assert(
    result.errors.some(
      (error) =>
        error.includes("create-local-user") && error.includes("callers"),
    ),
  );
});

test("a newly registered Go route cannot silently inherit network trust", async () => {
  const { checkRepository } = await checker();
  const result = await checkRepository({
    transformSource(path, source) {
      if (path === "services/identity-service/internal/rpc/handler.go")
        return source.replace(
          'handler.mux.HandleFunc("POST /rpc/identity/create-local-user", handler.createLocalUser)',
          'handler.mux.HandleFunc("POST /rpc/identity/new-admin-route", handler.createLocalUser)\n' +
            'handler.mux.HandleFunc("POST /rpc/identity/create-local-user", handler.createLocalUser)',
        );
      return source;
    },
  });
  assert(result.errors.some((error) => error.includes("new-admin-route")));
});

test("dropping an existing route policy is detected independently of its source", async () => {
  const { checkRepository } = await checker();
  const result = await checkRepository({
    transformPolicy(service, policy) {
      if (service === "runtime-controller")
        delete policy.routes["POST /internal/runtimes/{agent_id}/initialize"];
      return policy;
    },
  });
  assert(
    result.errors.some(
      (error) => error.includes("initialize") && error.includes("missing"),
    ),
  );
});

test("an unknown dynamic Go registration fails closed instead of being skipped", async () => {
  const { checkRepository } = await checker();
  const result = await checkRepository({
    transformSource(path, source) {
      if (path === "services/identity-service/internal/rpc/handler.go")
        return source.replace(
          'handler.mux.HandleFunc("POST /rpc/identity/create-local-user", handler.createLocalUser)',
          "handler.mux.HandleFunc(unknownRoute(), handler.createLocalUser)",
        );
      return source;
    },
  });
  assert(
    result.errors.some((error) => error.includes("unresolved registration")),
  );
});

test("a changed TypeScript route matcher requires an explicit catalog review", async () => {
  const { checkRepository } = await checker();
  const result = await checkRepository({
    transformSource(path, source) {
      if (path === "services/agent-ui/web/server/src/http/session-routes.ts")
        return source.replace(
          'suffix[1] !== "sessions"',
          'suffix[1] !== "hidden-admin"',
        );
      return source;
    },
  });
  assert(
    result.errors.some(
      (error) =>
        error.includes("session-routes.ts") && error.includes("review"),
    ),
  );
});

test("a public bypass cannot be declared for an internal business route", async () => {
  const { checkRepository } = await checker();
  const result = await checkRepository({
    transformPolicy(service, policy) {
      if (service === "identity-service")
        policy.routes["POST /rpc/identity/create-local-user"].authentication =
          "public";
      return policy;
    },
  });
  assert(
    result.errors.some(
      (error) =>
        error.includes("create-local-user") && error.includes("public"),
    ),
  );
});

test("a second named registration wrapper cannot borrow another wrapper's policies", async () => {
  const { checkRepository } = await checker();
  const result = await checkRepository({
    transformSource(path, source) {
      if (path === "services/runtime-controller/internal/rpc/handler.go")
        return source.replace(
          'mux.HandleFunc("GET /status", handler.status)',
          "extraRPC := func(pattern string, endpoint http.HandlerFunc) { mux.Handle(pattern, endpoint) }\n" +
            'extraRPC("POST /internal/hidden-admin", handler.status)\n' +
            'mux.HandleFunc("GET /status", handler.status)',
        );
      return source;
    },
  });
  assert(result.errors.some((error) => error.includes("hidden-admin")));
});

test("new matcher files cannot escape the reviewed TypeScript catalog", async () => {
  const { checkRepository } = await checker();
  const result = await checkRepository({
    additionalSources: {
      "services/agent-ui/web/server/src/application/hidden-server.ts": {
        service: "agent-ui",
        source: 'createServer((request, response) => response.end("hidden"));',
      },
    },
  });
  assert(
    result.errors.some(
      (error) => error.includes("hidden-server.ts") && error.includes("review"),
    ),
  );
});

test("Go route discovery covers a mux variable with an arbitrary name", async () => {
  const { checkRepository } = await checker();
  const result = await checkRepository({
    additionalSources: {
      "services/identity-service/internal/server/new-routes.go": {
        service: "identity-service",
        source:
          'package server\nimport "net/http"\nfunc registerPrivate(router *http.ServeMux) { router.Handle("POST /rpc/identity/hidden", http.NotFoundHandler()) }',
      },
    },
  });
  assert(
    result.errors.some(
      (error) => error.includes("hidden") && error.includes("missing"),
    ),
  );
});

test("an exact business route cannot replace authentication with mux delegation", async () => {
  const { checkRepository } = await checker();
  const result = await checkRepository({
    transformPolicy(service, policy) {
      if (service === "identity-service")
        policy.routes["POST /rpc/identity/create-local-user"].authentication =
          "delegate";
      return policy;
    },
  });
  assert(
    result.errors.some(
      (error) =>
        error.includes("create-local-user") && error.includes("delegate"),
    ),
  );
});

test("RC Skill preparation routes authorize only the actual Controller client", () => {
  const policy = JSON.parse(
    readFileSync(
      new URL(
        "../../services/runtime-controller/api/callers.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (const route of [
    "POST /internal/runtimes/{agent_id}/skill-sets/prepare",
    "GET /internal/runtimes/{agent_id}/skill-sets/preparations/{request_id}",
    "POST /internal/runtimes/{agent_id}/skill-sets/preparations/{request_id}/release",
  ]) {
    assert.deepEqual(policy.routes[route].callers, ["agent-controller"], route);
    assert.deepEqual(
      policy.routes[route].caller_context,
      { "agent-controller": "operation" },
      route,
    );
  }
});

function crossFileWrapper(pattern) {
  return {
    "services/runtime-controller/internal/rpc/review-a.go": {
      service: "runtime-controller",
      source: `package rpc
import "net/http"
func reg(mux *http.ServeMux, pattern string) { mux.Handle(pattern, http.NotFoundHandler()) }
func registerKnown(mux *http.ServeMux) { reg(mux, "POST /internal/runtimes/{agent_id}/skill-sets/prepare") }
`,
    },
    "services/runtime-controller/internal/rpc/review-b.go": {
      service: "runtime-controller",
      source: `package rpc
import "net/http"
func registerOther(mux *http.ServeMux) { reg(mux, ${pattern}) }
`,
    },
  };
}

test("a cross-file wrapper call without Handle cannot hide a newly registered route", async () => {
  const { checkRepository } = await checker();
  const result = await checkRepository({
    additionalSources: crossFileWrapper('"POST /internal/unlisted-new-route"'),
  });
  assert(
    result.errors.some(
      (error) =>
        error.includes("unlisted-new-route") && error.includes("missing"),
    ),
    JSON.stringify(result.errors),
  );
});

test("an unresolved cross-file wrapper argument cannot borrow a known route", async () => {
  const { checkRepository } = await checker();
  const result = await checkRepository({
    additionalSources: crossFileWrapper("unknownRoute()"),
  });
  assert(
    result.errors.some((error) => error.includes("unresolved registration")),
    JSON.stringify(result.errors),
  );
});

test("an unresolved cross-file wrapper prefix cannot disappear from a known route", async () => {
  const { checkRepository } = await checker();
  const sources = crossFileWrapper("unknownPrefix()");
  sources["services/runtime-controller/internal/rpc/review-a.go"].source =
    `package rpc
import "net/http"
func reg(mux *http.ServeMux, prefix string) { mux.Handle(prefix + "/internal/runtimes/{agent_id}/skill-sets/prepare", http.NotFoundHandler()) }
func registerKnown(mux *http.ServeMux) { reg(mux, "POST ") }
`;
  const result = await checkRepository({ additionalSources: sources });
  assert(
    result.errors.some((error) => error.includes("unresolved registration")),
    JSON.stringify(result.errors),
  );
});

test("same-named wrappers in different Go packages do not share route arguments", async () => {
  const { checkRepository } = await checker();
  const result = await checkRepository({
    additionalSources: {
      ...crossFileWrapper(
        '"POST /internal/runtimes/{agent_id}/skill-sets/prepare"',
      ),
      "services/runtime-controller/internal/other-rpc/review-c.go": {
        service: "runtime-controller",
        source: `package rpc
import "net/http"
func reg(_ *http.ServeMux, _ string) {}
func unrelated(mux *http.ServeMux) { reg(mux, "POST /internal/not-a-route") }
`,
      },
    },
  });
  assert.deepEqual(result.errors, []);
});
