import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
