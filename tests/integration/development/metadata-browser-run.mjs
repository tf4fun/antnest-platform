import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "../../../services/agent-ui/web/node_modules/vite/dist/node/index.js";
import { runCommand } from "../../support/run-command.mjs";
import { durablePath } from "../../support/storage.mjs";
import { writeDevelopmentJSON } from "../../support/development-configuration.mjs";
import { writeFileSync } from "node:fs";
import { audioData } from "../../e2e/acp-multimodal/fixtures.mjs";

// Actual UI, Chromium and SDK; only Gateway/ACP responses are local fixtures.
// No Provider, retained Agent, database or Docker operation is involved.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { WebSocketServer } = require("ws");
const { values } = parseArgs({
  options: {
    output: { type: "string" },
    case: { type: "string" },
    history: { type: "string" },
  },
});
assert(values.output, "--output is required");
const output = durablePath(values.output);
if (values.history)
  assert(
    statSync(durablePath(values.history)).isFile(),
    "historical report must be a regular file",
  );
const historical = values.history
  ? JSON.parse(readFileSync(durablePath(values.history), "utf8"))
  : undefined;
const rejection = {
  code: -32022,
  error_class: "model_unsupported_content",
  message:
    "The selected model does not support this attachment type. Use a model that supports the attachment, or start a new conversation without it.",
};
const agentId = "agent_" + "a".repeat(32);
const defaultSession = "11111111-2222-4333-8444-555555555555";
const defaultRejected = "21111111-2222-4333-8444-555555555555";
const checks = [
  "two_page_metadata_list_reload_history_without_replay",
  "unsupported_audio_actionable_error_and_composer_recovery",
];
const cases = [
  "success",
  ...(historical ? ["historical-report"] : []),
  "stop-reason",
  "observer-metadata",
  "listed-metadata",
  "reload-history",
  "rejection-error",
  "close-error",
  "interrupted",
];
if (values.case) assert(cases.includes(values.case), "unknown case");
let existing;
try {
  existing = lstatSync(output);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
assert(!existing, "fixture output must be a fresh directory");
process.umask(0o077);
mkdirSync(output, { recursive: true, mode: 0o700 });
const ui = durablePath(join(output, "ui"));
await build({
  root: join(root, "services/agent-ui/web"),
  configFile: join(root, "services/agent-ui/web/vite.config.ts"),
  logLevel: "error",
  build: { outDir: ui, emptyOutDir: false },
});
const results = [];
for (const kind of values.case ? [values.case] : cases) {
  const folder = durablePath(join(output, kind)),
    evidence = durablePath(join(folder, "evidence with spaces"));
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const write = (name, data) =>
    writeDevelopmentJSON({ output: folder }, name, data);
  const sessionId =
    kind === "historical-report" ? historical.session_id : defaultSession;
  const rejectedId =
    kind === "historical-report"
      ? historical.rejected_session_id
      : defaultRejected;
  const before =
    kind === "historical-report"
      ? historical.metadata.before
      : "2026-09-17T01:00:00.000Z";
  const after =
    kind === "historical-report"
      ? historical.metadata.after
      : "2026-09-17T02:00:00.000Z";
  const title =
    kind === "historical-report"
      ? historical.metadata.title
      : "Metadata fixture";
  const metadata = () => ({
    sessionUpdate: "session_info_update",
    title,
    updatedAt: prompted ? after : before,
  });
  const history = [
    {
      sessionUpdate: "agent_message_chunk",
      messageId: "initial",
      content: { type: "text", text: "Saved conversation" },
    },
  ];
  const subscriptions = new Map(),
    sse = new Set(),
    rpc = [],
    failures = [],
    http = [];
  let prompted = false,
    newSession = false,
    loginCount = 0,
    connection = 0;
  const notify = (socket, sid, update) =>
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: sid, update },
      }),
    );
  const state = {
    agent_id: agentId,
    availability: "ready",
    access_allowed: true,
    configuration_revision: "a".repeat(64),
    unavailable_reason: null,
    active_session_id: null,
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://fixture");
      http.push(url.pathname);
      if (url.pathname === "/api/session/login") {
        assert.equal(request.method, "POST");
        let body = "";
        for await (const chunk of request) body += chunk;
        assert.deepEqual(JSON.parse(body), {
          organization_slug: "fixture",
          email: "fixture@example.invalid",
          password: "fixture-password",
        });
        loginCount++;
        response.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": "antnest_session=fixture-cookie; HttpOnly; Path=/",
        });
        response.end('{"ok":true}');
        return;
      }
      if (url.pathname.startsWith("/api/"))
        assert.match(
          request.headers.cookie ?? "",
          /antnest_session=fixture-cookie/,
        );
      if (url.pathname === "/api/app/bootstrap") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            principal: {
              user_id: "user",
              organization_id: "organization",
              administrator: true,
            },
            agents: [
              {
                agent_id: agentId,
                name: "Metadata Agent",
                lifecycle_state: "created",
                activation_state: "enabled",
                runtime_state: "available",
              },
            ],
          }),
        );
        return;
      }
      if (url.pathname === `/api/app/agents/${agentId}/state/watch`) {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
        });
        response.write(
          `event: workspace_state\ndata: ${JSON.stringify(state)}\n\n`,
        );
        sse.add(response);
        response.on("close", () => sse.delete(response));
        return;
      }
      if (!url.pathname.startsWith("/workspace/")) {
        response.statusCode = 404;
        response.end();
        return;
      }
      const relative =
        decodeURIComponent(url.pathname.slice("/workspace/".length)) ||
        "index.html";
      const path = resolve(ui, relative);
      assert(path.startsWith(ui + "/"));
      response.setHeader(
        "content-type",
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
        }[extname(path)] ?? "application/octet-stream",
      );
      response.end(readFileSync(path));
    } catch (error) {
      failures.push(error.message);
      response.statusCode = 500;
      response.end("fixture assertion failed");
    }
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== `/api/app/agents/${agentId}/v1/acp`) {
      socket.destroy();
      return;
    }
    if (
      !(request.headers.cookie ?? "").includes("antnest_session=fixture-cookie")
    ) {
      failures.push("missing WS cookie");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) =>
      sockets.emit("connection", ws, request),
    );
  });
  sockets.on("connection", (socket) => {
    const number = ++connection;
    subscriptions.set(socket, new Set());
    socket.on("close", () => subscriptions.delete(socket));
    socket.on("error", (error) => failures.push(error.message));
    socket.on("message", (raw) => {
      let id;
      try {
        const message = JSON.parse(String(raw));
        ({ id } = message);
        const { method, params } = message;
        rpc.push({ connection: number, ...message });
        const send = (result) =>
          socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
        if (method === "initialize")
          return send({
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: { audio: true },
              sessionCapabilities: { list: {} },
            },
          });
        if (method === "session/list")
          return send({
            sessions: [
              {
                sessionId,
                cwd: "/workspace",
                title:
                  kind === "listed-metadata" && prompted
                    ? "Wrong title"
                    : title,
                updatedAt: prompted ? after : before,
              },
              ...(newSession
                ? [
                    {
                      sessionId: rejectedId,
                      cwd: "/workspace",
                      title: "Rejected audio",
                      updatedAt: after,
                    },
                  ]
                : []),
            ],
          });
        if (method === "session/new") {
          assert.equal(params.cwd, "/workspace");
          assert.deepEqual(params.mcpServers, []);
          assert(!newSession);
          newSession = true;
          subscriptions.get(socket).add(rejectedId);
          return send({ sessionId: rejectedId, configOptions: [] });
        }
        if (method === "session/load") {
          assert.equal(params.cwd, "/workspace");
          assert.deepEqual(params.mcpServers, []);
          assert(
            [sessionId, ...(newSession ? [rejectedId] : [])].includes(
              params.sessionId,
            ),
          );
          subscriptions.get(socket).add(params.sessionId);
          if (params.sessionId === sessionId) {
            for (const update of history)
              notify(
                socket,
                sessionId,
                kind === "reload-history" &&
                  prompted &&
                  update.messageId === "answer"
                  ? {
                      ...update,
                      content: { type: "text", text: "Changed history" },
                    }
                  : update,
              );
            notify(socket, sessionId, metadata());
          }
          return send({ configOptions: [] });
        }
        if (method === "session/prompt") {
          if (params.sessionId === sessionId) {
            assert(!prompted, "unexpected prompt replay");
            assert.deepEqual(params.prompt, [
              {
                type: "text",
                text: "Reply with exactly DEPLOYMENT-METADATA-OK. Do not use tools.",
              },
            ]);
            prompted = true;
            const added = [
              {
                sessionUpdate: "user_message_chunk",
                messageId: "prompt",
                content: params.prompt[0],
              },
              {
                sessionUpdate: "agent_message_chunk",
                messageId: "answer",
                content: { type: "text", text: "DEPLOYMENT-METADATA-OK" },
              },
            ];
            history.push(...added);
            if (kind === "interrupted") {
              process.kill(
                Number(readFileSync(join(folder, "child.pid"), "utf8")),
                "SIGTERM",
              );
              return;
            }
            for (const [client, ids] of subscriptions)
              if (ids.has(sessionId)) {
                for (const update of added)
                  if (
                    client !== socket ||
                    update.sessionUpdate !== "user_message_chunk"
                  )
                    notify(client, sessionId, update);
                notify(client, sessionId, {
                  ...metadata(),
                  ...(kind === "observer-metadata" && client !== socket
                    ? { title: "Wrong observer title" }
                    : {}),
                });
              }
            return send({
              stopReason: kind === "stop-reason" ? "cancelled" : "end_turn",
            });
          }
          assert.equal(params.sessionId, rejectedId);
          assert(newSession);
          assert.equal(
            params.prompt.find((block) => block.type === "text")?.text,
            "Deployment unsupported audio check",
          );
          const audio = params.prompt.find((block) => block.type === "audio");
          assert(audio);
          assert.equal(audio.mimeType, "audio/wav");
          assert.equal(audio.data, audioData);
          return socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: {
                code: -32022,
                message: "Agent Run failed",
                data: {
                  code:
                    kind === "rejection-error"
                      ? "other_failure"
                      : "model_unsupported_content",
                  retryable: false,
                },
              },
            }),
          );
        }
        if (method === "session/cancel") return;
        throw new Error("unexpected method " + method);
      } catch (error) {
        failures.push(error.message);
        if (id !== undefined)
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32603, message: "fixture assertion failed" },
            }),
          );
      }
    });
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const envFile = join(folder, "fixture.env");
    writeFileSync(
      envFile,
      "ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG=fixture\nANTNEST_BOOTSTRAP_ADMIN_EMAIL=fixture@example.invalid\nANTNEST_BOOTSTRAP_ADMIN_PASSWORD=fixture-password\n",
      { flag: "wx", mode: 0o600 },
    );
    write("config.json", {
      output: evidence,
      gateway: origin,
      envFile,
      agentId,
      sessionId,
      workspaceUrl: `${origin}/workspace/?agent=${agentId}&session=${sessionId}`,
    });
    const command = [process.execPath];
    {
      const preload = `import {createRequire} from 'node:module';import fs from 'node:fs';const require=createRequire(${JSON.stringify(join(root, "services/agent-ui/web/package.json"))});fs.writeFileSync(${JSON.stringify(join(folder, "child.pid"))},String(process.pid),{flag:'wx',mode:0o600});const chromium=require('playwright').chromium,launch=chromium.launch.bind(chromium);chromium.launch=async(...args)=>{const browser=await launch(...args),close=browser.close.bind(browser),newContext=browser.newContext.bind(browser),events=[];browser.newContext=async(...args)=>{const context=await newContext(...args);context.on('page',page=>{page.on('console',m=>events.push({type:m.type(),text:m.text()}));page.on('requestfailed',r=>events.push({url:r.url(),failure:r.failure()}));});return context};let closing;browser.close=()=>closing??=(async()=>{const pages=[];for(const context of browser.contexts())for(const page of context.pages()){try{pages.push({url:page.url(),html:await page.content()})}catch{}}fs.writeFileSync(${JSON.stringify(join(folder, "browser.private.json"))},JSON.stringify({pages,events}),{flag:'wx',mode:0o600});await close();${kind === "close-error" ? "throw new Error('fixture close failure')" : ""}})();return browser};`;
      command.push(
        "--import",
        "data:text/javascript," + encodeURIComponent(preload),
      );
    }
    command.push(
      join(root, "tests/e2e/development/metadata-browser.mjs"),
      "--config",
      join(folder, "config.json"),
    );
    const result = await runCommand({
      command,
      output: folder,
      name: "metadata-cli",
      timeoutMs: kind === "interrupted" ? 20000 : 185000,
      graceMs: 15000,
    });
    write("requests.private.json", rpc);
    write("fixture.json", {
      loginCount,
      connections: connection,
      failures,
      http,
    });
    assert.deepEqual(failures, []);
    assert.equal(loginCount, 1);
    assert.equal(result.complete, true);
    const report = JSON.parse(
      readFileSync(join(evidence, "metadata-report.json"), "utf8"),
    );
    const success = ["success", "historical-report"].includes(kind);
    assert.equal(result.exit_code, success ? 0 : 1);
    assert.equal(report.status, success ? "passed" : "failed");
    if (success) {
      assert.deepEqual(report.checks, checks);
      assert.equal(report.browser_errors, 0);
      assert.deepEqual(report.metadata, {
        title,
        before,
        after,
        observers: 2,
        list_reload: "matched",
        reload_prompt_count: 0,
      });
      assert.deepEqual(report.rejection, rejection);
      assert.equal(report.session_id, sessionId);
      assert.equal(report.rejected_session_id, rejectedId);
      assert.equal(
        rpc.filter(
          (x) =>
            x.method === "session/prompt" && x.params.sessionId === sessionId,
        ).length,
        1,
      );
      assert.equal(
        rpc.filter(
          (x) =>
            x.method === "session/prompt" && x.params.sessionId === rejectedId,
        ).length,
        1,
      );
      assert.equal(
        rpc.filter(
          (x) =>
            x.method === "session/load" && x.params.sessionId === sessionId,
        ).length,
        3,
      );
      for (const name of ["metadata-desktop.png", "capability-rejection.png"]) {
        const path = join(evidence, name),
          data = readFileSync(path);
        assert(data.length > 1000);
        assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
        assert.equal(statSync(path).mode & 0o777, 0o600);
      }
      if (kind === "historical-report") assert.deepEqual(report, historical);
    } else {
      assert.equal(
        report.error_type,
        kind === "close-error"
          ? "Error"
          : kind === "interrupted"
            ? "Interrupted"
            : "AssertionError",
      );
      assert.equal(
        report.checks.length,
        kind === "close-error" ? 2 : kind === "rejection-error" ? 1 : 0,
      );
    }
    results.push({
      kind,
      status: "passed",
      expected: success ? "passed" : "failed",
      checks: report.checks,
    });
  } finally {
    for (const response of sse) response.end();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
writeDevelopmentJSON({ output }, "result.json", {
  status: "passed",
  cases: results,
  scope:
    "Real UI/Chromium and SDK with local Gateway/ACP wire fixtures; historical JSON report compatibility, not original browser frame replay or deployed business acceptance.",
});
console.log(JSON.stringify({ status: "passed", cases: results.length }));
