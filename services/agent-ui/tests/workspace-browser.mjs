import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "../web/node_modules/vite/dist/node/index.js";
import { chromium } from "../web/node_modules/playwright/index.mjs";

// Gateway/ACP are deterministic wire fixtures. Browser and ACP SDK are real;
// this is reusable client integration evidence, not deployed execution evidence.
const sessions = new Map();
const states = new Map();
const observers = new Map();
const requests = [];
const timers = new Set();
const agents = [
  { agent_id: "agent-one", name: "Research Partner" },
  { agent_id: "agent-two", name: "Operations Assistant" },
];
const configuration = [
  {
    id: "model",
    name: "Model",
    type: "select",
    currentValue: "deepseek",
    options: [{ value: "deepseek", name: "DeepSeek" }],
  },
];
let socketCount = 0;
let serial = 0;
const key = (agent, session) => JSON.stringify([agent, session]);
const ready = (agent) => ({
  agent_id: agent,
  availability: "ready",
  access_allowed: true,
  configuration_revision: "a".repeat(64),
  unavailable_reason: null,
  active_session_id: null,
});
const publishState = (agent, state) => {
  states.set(agent, state);
  for (const response of observers.get(agent) ?? [])
    response.write(
      `event: workspace_state\ndata: ${JSON.stringify(state)}\n\n`,
    );
};
const update = (text, messageId = "answer") => ({
  sessionUpdate: "agent_message_chunk",
  messageId,
  content: { type: "text", text },
});
for (const agent of agents) {
  states.set(agent.agent_id, ready(agent.agent_id));
  sessions.set(key(agent.agent_id, "saved-session"), {
    sessionId: "saved-session",
    title: "Quarterly research notes",
    cwd: "/workspace",
    updatedAt: "2026-09-15T00:00:00Z",
    history: [update(`Saved answer from ${agent.name}`)],
  });
}
const output = fileURLToPath(
  new URL("../../../.cache/agent-ui-browser/", import.meta.url),
);
await mkdir(output, { recursive: true });
const server = await createServer({
  root: fileURLToPath(new URL("../web", import.meta.url)),
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "gateway-fixture",
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          const url = new URL(request.url, "http://fixture");
          if (url.pathname === "/api/app/bootstrap") {
            response.setHeader("Content-Type", "application/json");
            response.end(
              JSON.stringify({
                principal: {
                  user_id: "user",
                  organization_id: "org",
                  administrator: true,
                },
                agents,
              }),
            );
            return;
          }
          const match = /^\/api\/app\/agents\/([^/]+)\/state\/watch$/.exec(
            url.pathname,
          );
          if (!match) return next();
          const agent = decodeURIComponent(match[1]);
          response.setHeader("Content-Type", "text/event-stream");
          response.setHeader("Cache-Control", "no-store");
          const group = observers.get(agent) ?? new Set();
          group.add(response);
          observers.set(agent, group);
          response.write(
            `event: workspace_state\ndata: ${JSON.stringify(states.get(agent))}\n\n`,
          );
          response.on("close", () => group.delete(response));
        });
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.routeWebSocket("**/api/app/agents/*/v1/acp", (socket) => {
    socketCount++;
    const agent = new URL(socket.url()).pathname.split("/")[4];
    const send = (id, result) =>
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
    const notify = (sessionId, value) =>
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId, update: value },
        }),
      );
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      requests.push({ agent, ...message });
      const { id, method, params } = message;
      const current = sessions.get(key(agent, params?.sessionId));
      switch (method) {
        case "initialize":
          send(id, {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: { image: true, embeddedContext: true },
              sessionCapabilities: { list: {} },
            },
          });
          break;
        case "session/list":
          send(id, {
            sessions: [...sessions.entries()]
              .filter(([id]) => JSON.parse(id)[0] === agent)
              .map(([, { history, ...value }]) => value),
          });
          break;
        case "session/new": {
          assert.equal(params.cwd, "/workspace");
          assert.deepEqual(params.mcpServers, []);
          const sessionId = `session-${++serial}`;
          sessions.set(key(agent, sessionId), {
            sessionId,
            title: "New conversation",
            cwd: "/workspace",
            history: [],
          });
          send(id, { sessionId, configOptions: configuration });
          break;
        }
        case "session/load": {
          assert.equal(params.cwd, "/workspace");
          assert.deepEqual(params.mcpServers, []);
          if (!current) {
            socket.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                error: { code: -32002, message: "Session not found" },
              }),
            );
            break;
          }
          for (const value of current.history) notify(params.sessionId, value);
          send(id, { configOptions: configuration });
          break;
        }
        case "session/prompt": {
          assert(current);
          publishState(agent, {
            ...ready(agent),
            availability: "busy",
            active_session_id: params.sessionId,
          });
          const prompt = {
            sessionUpdate: "user_message_chunk",
            messageId: `user-${id}`,
            content: params.prompt[0],
          };
          const tool = {
            sessionUpdate: "tool_call",
            toolCallId: `tool-${id}`,
            title: "Read quarterly notes",
            kind: "read",
            status: "completed",
            rawInput: { path: "/workspace/notes.md" },
            rawOutput: "Revenue increased by 12%.",
          };
          const plan = {
            sessionUpdate: "plan",
            entries: [
              {
                content: "Review the evidence",
                status: "completed",
                priority: "high",
              },
            ],
          };
          notify(params.sessionId, tool);
          notify(params.sessionId, plan);
          notify(params.sessionId, update("The report ", `answer-${id}`));
          const timer = setTimeout(() => {
            timers.delete(timer);
            notify(params.sessionId, update("is ready.", `answer-${id}`));
            current.history.push(
              prompt,
              tool,
              plan,
              update("The report is ready.", `answer-${id}`),
            );
            send(id, { stopReason: "end_turn" });
            publishState(agent, ready(agent));
          }, 200);
          timers.add(timer);
          break;
        }
        case "session/cancel":
          publishState(agent, ready(agent));
          break;
        case "session/set_config_option":
          send(id, { configOptions: configuration });
          break;
        default:
          throw new Error(`Unexpected ACP method ${method}`);
      }
    });
  });

  await page.goto(`${origin}/workspace/`);
  await page.getByRole("heading", { name: "Your agents" }).waitFor();
  assert.equal(socketCount, 0);
  await page.screenshot({ path: `${output}/agents-desktop.png` });
  await page.getByRole("button", { name: /Research Partner/ }).click();
  await page.waitForFunction(
    () => !document.querySelector("textarea")?.disabled,
  );
  assert.equal(requests.filter((r) => r.method === "session/new").length, 0);
  await page.getByRole("button", { name: /Quarterly research notes/ }).click();
  await page
    .getByText("Saved answer from Research Partner", { exact: true })
    .waitFor();
  await page
    .getByRole("textbox", { name: "Message" })
    .fill("Please review the notes.");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText("The report is ready.", { exact: true }).waitFor();
  await page.waitForFunction(
    () => !document.querySelector("textarea")?.disabled,
  );
  assert.equal(await page.locator(".tool-activity[open]").count(), 0);
  await page.locator(".tool-activity summary").click();
  await page.getByText("/workspace/notes.md", { exact: false }).waitFor();
  await page.getByText("Revenue increased by 12%.", { exact: true }).waitFor();
  await page.screenshot({ path: `${output}/chat-desktop.png` });
  const savedURL = page.url();
  await page.reload();
  await page.getByText("The report is ready.", { exact: true }).waitFor();
  assert.equal(page.url(), savedURL);
  assert.equal(requests.filter((r) => r.method === "session/prompt").length, 1);
  await page
    .getByRole("textbox", { name: "Message" })
    .fill("Unsent private draft");
  await page.getByRole("button", { name: /Operations Assistant/ }).click();
  assert.equal(
    await page.getByRole("textbox", { name: "Message" }).inputValue(),
    "",
  );
  await page.getByRole("button", { name: /Quarterly research notes/ }).click();
  await page
    .getByText("Saved answer from Operations Assistant", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByText("The report is ready.", { exact: true }).count(),
    0,
  );
  await page.goBack();
  await page.goBack();
  await page.getByText("The report is ready.", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("textbox", { name: "Message" }).inputValue(),
    "Unsent private draft",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.querySelector(".sidebar").getBoundingClientRect().right <= 1,
  );
  await page.screenshot({ path: `${output}/chat-mobile.png` });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("searchbox", { name: "Search conversations" })
    .fill("missing");
  await page.getByText("No matching conversations").waitFor();
  await page.screenshot({ path: `${output}/navigation-mobile.png` });
  await page.getByRole("button", { name: "All agents" }).click();
  await page.getByRole("heading", { name: "Your agents" }).waitFor();
  await page.screenshot({ path: `${output}/agents-mobile.png` });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
    })),
    { local: 0, session: 0 },
  );
  console.log(
    JSON.stringify({
      result: "passed",
      scope: "browser + production ACP SDK against Gateway/ACP wire fixtures",
      viewports: 2,
      prompts: 1,
      reloadResends: 0,
      browserErrors: 0,
      screenshots: output,
    }),
  );
} finally {
  for (const timer of timers) clearTimeout(timer);
  await browser?.close();
  for (const group of observers.values())
    for (const response of group) response.end();
  await server.close();
}
