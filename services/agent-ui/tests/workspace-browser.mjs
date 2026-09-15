import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "../web/node_modules/vite/dist/node/index.js";
import { chromium } from "../web/node_modules/playwright/index.mjs";
import {
  assertReadableText,
  assertTouchTargets,
} from "./visual-assertions.mjs";

// Gateway/ACP are deterministic wire fixtures. Browser and ACP SDK are real;
// this is reusable client integration evidence, not deployed execution evidence.
const sessions = new Map();
const states = new Map();
const observers = new Map();
const requests = [];
const reportAnswer =
  "The report is ready.\n\n## Quarterly summary\n\nRevenue increased by **12%**. The figures match the source report.\n\n| Metric | Current | Previous | Change |\n| --- | --- | --- | --- |\n| Revenue | $112,000 | $100,000 | +12% |\n| Customers | 840 | 800 | +5% |\n\n### Verification\n\n```text\nsource=/workspace/reports/quarterly/revenue-comparison-and-supporting-notes.md\nresult=verified\n```\n\nThe report is ready to share.";
const timers = new Set();
const agents = [
  {
    agent_id: "agent-one",
    name: "Research Partner",
    lifecycle_state: "created",
    activation_state: "enabled",
    runtime_state: "available",
  },
  {
    agent_id: "agent-two",
    name: "Operations Assistant",
    lifecycle_state: "created",
    activation_state: "disabled",
    runtime_state: "exited",
  },
];
const configuration = [
  {
    id: "model",
    name: "Model",
    type: "select",
    category: "model",
    currentValue: "deepseek",
    options: [
      {
        group: "deepseek",
        name: "DeepSeek",
        options: [
          { value: "deepseek", name: "Flash" },
          { value: "reasoner", name: "Pro" },
        ],
      },
    ],
  },
  {
    id: "mode",
    name: "Mode",
    type: "select",
    currentValue: "ask",
    options: [
      { value: "ask", name: "Ask first" },
      { value: "allow", name: "Allow" },
    ],
  },
  {
    id: "thinking_effort",
    name: "Thinking",
    type: "select",
    category: "thought_level",
    currentValue: "default",
    options: [
      { value: "default", name: "Model default" },
      { value: "off", name: "Off" },
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
    ],
  },
];
let socketCount = 0;
let serial = 0;
let requestApproval;
let approvalResponse;
let bootstrapUnavailable = false;
let directoryMode = "normal";
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
    history: [
      update(`Saved answer from ${agent.name}`),
      {
        sessionUpdate: "usage_update",
        used: 2800,
        size: 64000,
        cost: { amount: 0.004, currency: "USD" },
      },
    ],
    configOptions: structuredClone(configuration),
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
            if (bootstrapUnavailable) {
              response.statusCode = 503;
              response.end("Temporarily unavailable");
              return;
            }
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
  // Keep copy verification isolated from the developer's system clipboard.
  await context.addInitScript(() => {
    window.copiedPayloads = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.copiedPayloads.push(text);
        },
      },
    });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.routeWebSocket("**/api/app/agents/*/v1/acp", (socket) => {
    socketCount++;
    const agent = new URL(socket.url()).pathname.split("/")[4];
    requestApproval = () =>
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "visual-approval",
          method: "session/request_permission",
          params: {
            sessionId: "saved-session",
            toolCall: {
              toolCallId: "approval-tool",
              title: "Run the quarterly verification script",
              rawInput: { command: "node /workspace/verify-report.js" },
            },
            options: [
              { optionId: "once", kind: "allow_once", name: "Allow once" },
              { optionId: "reject", kind: "reject_once", name: "Reject" },
            ],
          },
        }),
      );
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
      if (message.id === "visual-approval") {
        approvalResponse = message.result;
        return;
      }
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
          if (directoryMode === "failed") {
            socket.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32603,
                  message: "Directory temporarily unavailable",
                },
              }),
            );
            break;
          }
          if (directoryMode === "paged" && params.cursor === "older") {
            send(id, {
              sessions: [
                {
                  sessionId: "older-session",
                  title: "Older conversation",
                  cwd: "/workspace",
                  updatedAt: "2026-08-01T00:00:00Z",
                },
              ],
            });
            break;
          }
          send(id, {
            sessions: [...sessions.entries()]
              .filter(([id]) => JSON.parse(id)[0] === agent)
              .map(([, { history, ...value }]) => value),
            ...(directoryMode === "paged" ? { nextCursor: "older" } : {}),
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
            configOptions: structuredClone(configuration),
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
          send(id, { configOptions: current.configOptions });
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
          const progress = update(
            "I will read the report and verify the figures before summarizing.",
            `progress-${id}`,
          );
          const thought = {
            sessionUpdate: "agent_thought_chunk",
            messageId: `thought-${id}`,
            content: {
              type: "text",
              text: "Compare the current and previous periods using the source notes.",
            },
          };
          const verify = {
            ...tool,
            toolCallId: `verify-${id}`,
            title: "Verify totals against the source report",
            kind: "execute",
            status: "in_progress",
            rawInput: { command: "node /workspace/verify-report.js" },
            rawOutput: undefined,
          };
          notify(params.sessionId, progress);
          notify(params.sessionId, thought);
          notify(params.sessionId, tool);
          notify(params.sessionId, verify);
          notify(params.sessionId, plan);
          notify(params.sessionId, update("The report ", `answer-${id}`));
          const timer = setTimeout(() => {
            timers.delete(timer);
            const verified = {
              ...verify,
              status: "completed",
              rawOutput: "All checks passed.\nSource data preserved.",
            };
            notify(params.sessionId, {
              ...verified,
              sessionUpdate: "tool_call_update",
            });
            notify(
              params.sessionId,
              update(reportAnswer.slice("The report ".length), `answer-${id}`),
            );
            current.history.push(
              prompt,
              progress,
              thought,
              tool,
              verified,
              plan,
              update(reportAnswer, `answer-${id}`),
            );
            send(id, { stopReason: "end_turn" });
            publishState(agent, ready(agent));
          }, 800);
          timers.add(timer);
          break;
        }
        case "session/cancel":
          publishState(agent, ready(agent));
          break;
        case "session/set_config_option":
          current.configOptions = current.configOptions.map((option) =>
            option.id === params.configId
              ? { ...option, currentValue: params.value }
              : option,
          );
          send(id, { configOptions: current.configOptions });
          break;
        default:
          throw new Error(`Unexpected ACP method ${method}`);
      }
    });
  });

  await page.goto(`${origin}/workspace/`);
  await page.getByRole("heading", { name: "Your agents" }).waitFor();
  assert.equal(socketCount, 0);
  assert.equal(await page.locator(".sidebar").count(), 0);
  const cards = page.locator(".chooser-agent");
  await cards.nth(0).getByText("Available", { exact: true }).waitFor();
  await cards.nth(1).getByText("Disabled", { exact: true }).waitFor();
  const firstCard = await cards.nth(0).boundingBox();
  const secondCard = await cards.nth(1).boundingBox();
  assert(
    firstCard &&
      secondCard &&
      firstCard.y === secondCard.y &&
      secondCard.x > firstCard.x,
  );
  await page.getByRole("button", { name: "Refresh agents" }).click();
  await page.waitForFunction(
    () => !document.querySelector("[aria-label='Refresh agents']").disabled,
  );
  assert.equal(socketCount, 0);
  assert.equal(observers.size, 0);
  await page.screenshot({ path: `${output}/agents-desktop.png` });
  agents[1].activation_state = "enabled";
  agents[1].runtime_state = "waiting";
  await page.getByRole("button", { name: "Refresh agents" }).click();
  await cards
    .nth(1)
    .getByText("Waiting for startup", { exact: true })
    .waitFor();
  agents[1].runtime_state = "available";
  await page.getByRole("button", { name: "Refresh agents" }).click();
  await cards.nth(1).getByText("Available", { exact: true }).waitFor();
  assert.equal(socketCount, 0);
  assert.equal(observers.size, 0);
  await assertReadableText(page, [
    ".brand-copy small",
    ".chooser-count",
    ".chooser-id",
    ".chooser-kicker",
    ".chooser-account",
    ".presence",
  ]);
  directoryMode = "failed";
  await page.getByRole("link", { name: /Research Partner/ }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => !document.querySelector("textarea")?.disabled,
  );
  assert.equal(requests.filter((r) => r.method === "session/new").length, 1);
  await page.getByRole("button", { name: "Retry conversations" }).waitFor();
  const connectedBeforeRetry = socketCount;
  directoryMode = "paged";
  await page.getByRole("button", { name: "Retry conversations" }).click();
  await page.getByRole("button", { name: "Load more conversations" }).waitFor();
  assert.equal(socketCount, connectedBeforeRetry);
  await page.screenshot({ path: `${output}/catalog-paging-desktop.png` });
  await page.getByRole("button", { name: "Load more conversations" }).click();
  await page.getByRole("button", { name: /Older conversation/ }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Load more conversations" }).count(),
    0,
  );
  directoryMode = "normal";
  await page.screenshot({ path: `${output}/empty-conversation-desktop.png` });
  await page
    .getByRole("textbox", { name: "Message" })
    .fill("Unsent settings draft");
  await page.getByRole("combobox", { name: "Thinking" }).waitFor();
  await page.waitForFunction(
    () => !document.querySelector("textarea")?.disabled,
  );
  assert.equal(
    await page.getByRole("textbox", { name: "Message" }).inputValue(),
    "Unsent settings draft",
  );
  assert.equal(requests.filter((r) => r.method === "session/prompt").length, 0);
  await page.getByRole("combobox", { name: "Model", exact: true }).click();
  assert.equal(await page.getByRole("group", { name: "DeepSeek" }).count(), 1);
  await page.getByRole("searchbox", { name: "Search Model" }).press("Escape");
  await page.screenshot({ path: `${output}/new-session-settings-desktop.png` });
  await page.getByRole("button", { name: /Quarterly research notes/ }).click();
  await page
    .getByText("Saved answer from Research Partner", { exact: true })
    .waitFor();
  const composer = page.getByRole("group", { name: "Message composer" });
  await composer.getByRole("combobox", { name: "Model" }).click();
  await page.getByRole("option", { name: "Pro", exact: true }).click();
  await page.waitForFunction(
    () => !document.querySelector("textarea").disabled,
  );
  await composer.getByRole("combobox", { name: "Mode", exact: true }).click();
  await page.getByRole("option", { name: "Allow", exact: true }).click();
  await page.waitForFunction(
    () => !document.querySelector("textarea").disabled,
  );
  await composer.getByRole("combobox", { name: "Thinking" }).click();
  await page.getByRole("option", { name: "Max", exact: true }).click();
  await page.waitForFunction(
    () => !document.querySelector("textarea").disabled,
  );
  assert.deepEqual(
    requests
      .filter((r) => r.method === "session/set_config_option")
      .map((r) => r.params),
    [
      { sessionId: "saved-session", configId: "model", value: "reasoner" },
      { sessionId: "saved-session", configId: "mode", value: "allow" },
      { sessionId: "saved-session", configId: "thinking_effort", value: "max" },
    ],
  );
  await page
    .getByRole("textbox", { name: "Message" })
    .fill("Please review the notes.");
  await page.getByRole("button", { name: "Send message" }).click();
  await page
    .getByText(
      "I will read the report and verify the figures before summarizing.",
      { exact: true },
    )
    .waitFor();
  await page.getByText("The report is ready.", { exact: true }).waitFor();
  await page.waitForFunction(
    () => !document.querySelector("textarea")?.disabled,
  );
  assert.equal(await page.locator(".tool-activity[open]").count(), 0);
  const process = page.getByRole("button", {
    name: "Show process",
    exact: true,
  });
  await process.waitFor();
  assert.equal(await process.getAttribute("aria-expanded"), "false");
  assert.equal(
    await page
      .getByText(
        "I will read the report and verify the figures before summarizing.",
        { exact: true },
      )
      .isVisible(),
    false,
  );
  assert.equal(await page.locator(".assistant-avatar").count(), 0);
  const columns = await page.evaluate(() => ({
    prompt: document
      .querySelector(".message-user .message-content")
      .getBoundingClientRect().x,
    answer: document
      .querySelector(".message-answer .message-content")
      .getBoundingClientRect().x,
    background: getComputedStyle(document.querySelector(".message-user"))
      .backgroundColor,
  }));
  assert.equal(columns.prompt, columns.answer);
  assert.equal(columns.background, "rgba(0, 0, 0, 0)");
  assert.equal(await page.locator(".turn-heading").count(), 2);
  assert(
    await page.evaluate(
      () =>
        getComputedStyle(
          document.querySelector(".message-user .message-header"),
        ).color !==
        getComputedStyle(document.querySelector(".turn-agent-label")).color,
    ),
  );
  await page.screenshot({ path: `${output}/chat-desktop.png` });
  await assertReadableText(page, [
    ".brand-copy small",
    ".section-label",
    ".conversation-option small",
    ".profile-copy small",
    ".presence",
    ".topbar-agent small",
    ".turn-heading",
    ".message-content",
    ".message-header",
    ".session-settings label",
  ]);
  const readingPosition = await page
    .locator(".thread-scroll")
    .evaluate((element) => element.scrollTop);
  await process.click();
  await page.waitForFunction(
    (expected) =>
      document.querySelector(".thread-scroll").scrollTop === expected,
    readingPosition,
  );
  assert.equal(
    await page
      .getByText(
        "I will read the report and verify the figures before summarizing.",
        { exact: true },
      )
      .isVisible(),
    true,
  );
  assert.equal(await page.locator(".tool-activity").count(), 2);
  await page.locator(".tool-activity summary").first().click();
  await page.getByText("/workspace/notes.md", { exact: false }).waitFor();
  await page.getByText("Revenue increased by 12%.", { exact: true }).waitFor();
  const firstTool = page.locator(".tool-activity").first();
  await firstTool.locator("summary").focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  assert(
    await firstTool
      .locator("summary")
      .evaluate((element) => element.matches(":focus-visible")),
  );
  await page.keyboard.press("Space");
  assert.equal(await firstTool.getAttribute("open"), null);
  await page.keyboard.press("Enter");
  assert.notEqual(await firstTool.getAttribute("open"), null);
  await firstTool.getByRole("button", { name: "Copy input" }).click();
  await firstTool.getByRole("button", { name: "Copy output" }).click();
  assert.deepEqual(await page.evaluate(() => window.copiedPayloads), [
    JSON.stringify({ path: "/workspace/notes.md" }, null, 2),
    "Revenue increased by 12%.",
  ]);
  assert.notEqual(await firstTool.getAttribute("open"), null);
  await page.locator(".thought-process summary").click();
  assert(await page.locator(".thought-process .message-content").isVisible());
  const thinkingStyles = await page.evaluate(() => {
    const properties = (selector, keys) => {
      const style = getComputedStyle(document.querySelector(selector));
      return keys.map((key) => style[key]);
    };
    const frame = [
      "borderTopWidth",
      "borderTopColor",
      "borderRadius",
      "backgroundColor",
    ];
    const header = ["minHeight", "padding", "gap", "backgroundColor"];
    return {
      thinkingFrame: properties(".thought-process", frame),
      toolFrame: properties(".tool-activity", frame),
      thinkingHeader: properties(".thought-process > summary", header),
      toolHeader: properties(".tool-activity > summary", header),
      body: properties(".thought-process .message-content", [
        "borderTopWidth",
        "borderLeftWidth",
        "marginLeft",
      ]),
    };
  });
  assert.deepEqual(thinkingStyles.thinkingFrame, thinkingStyles.toolFrame);
  assert.deepEqual(thinkingStyles.thinkingHeader, thinkingStyles.toolHeader);
  assert.deepEqual(thinkingStyles.body, ["1px", "0px", "0px"]);
  const surfaces = await page.evaluate(() => ({
    process: getComputedStyle(document.querySelector(".turn-process-trigger"))
      .borderTopWidth,
    card: getComputedStyle(document.querySelector(".tool-activity"))
      .borderTopWidth,
    payload: getComputedStyle(document.querySelector(".tool-detail pre"))
      .borderTopWidth,
  }));
  assert.deepEqual(surfaces, { process: "1px", card: "1px", payload: "0px" });
  await page.screenshot({
    path: `${output}/chat-process-desktop.png`,
    animations: "disabled",
  });
  const savedURL = page.url();
  await page.reload();
  await page.getByText("The report is ready.", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Show process", exact: true })
    .waitFor();
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
  assert(await page.locator(".topbar-agent .presence").isVisible());
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const area = composer.getByRole("textbox", { name: "Message" });
    const before = await area.inputValue();
    await composer
      .getByRole("button", { name: "Expand message editor" })
      .click();
    assert.equal(await area.inputValue(), before);
    const check = async (locator) => {
      const box = await locator.boundingBox();
      assert(
        box &&
          box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= width &&
          box.y + box.height <= 844,
      );
    };
    await check(composer);
    await check(composer.getByRole("button", { name: "Send message" }));
    await assertTouchTargets(
      page,
      ".composer .icon-button, .composer .send-button, .usage-trigger, .config-trigger",
    );
    await composer.getByRole("button", { name: /Context usage/ }).click();
    await check(page.getByRole("group", { name: "Session usage" }));
    await page.screenshot({ path: `${output}/composer-expanded-${width}.png` });
    await page.keyboard.press("Escape");
    await composer
      .getByRole("button", { name: "Collapse message editor" })
      .click();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  // Resizing/expanding the editor can leave the transcript away from the
  // bottom. Resume following explicitly before asserting its settled layout.
  await page.locator(".thread-scroll").focus();
  await page.keyboard.press("Control+End");
  await page
    .getByRole("button", { name: "Show process", exact: true })
    .waitFor();
  await page.screenshot({ path: `${output}/chat-mobile.png` });
  await page.getByRole("button", { name: "Show process", exact: true }).click();
  await page.locator(".thought-process summary").click();
  assert(await page.locator(".thought-process .message-content").isVisible());
  await page.locator(".tool-activity summary").first().click();
  await page.locator(".tool-activity[open]").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `${output}/chat-process-mobile.png`,
    animations: "disabled",
  });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.locator(".session-plan summary").focus();
  await page.keyboard.press("Enter");
  assert.notEqual(
    await page.locator(".session-plan").getAttribute("open"),
    null,
  );
  assert(await page.locator(".session-plan li").first().isVisible());
  await page.screenshot({ path: `${output}/chat-plan-mobile.png` });
  const planHeader = await page
    .locator(".session-plan summary")
    .evaluate((element) => getComputedStyle(element).minHeight);
  assert.equal(planHeader, "44px");
  requestApproval();
  await page.getByRole("region", { name: "Tool approval" }).waitFor();
  await assertReadableText(page, [
    ".permission-request header",
    ".permission-conversation",
    ".permission-options button",
  ]);
  await assertTouchTargets(page, ".permission-options button");
  await page.screenshot({ path: `${output}/approval-mobile.png` });
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await page
    .getByRole("region", { name: "Tool approval" })
    .waitFor({ state: "hidden" });
  assert.deepEqual(approvalResponse, {
    outcome: { outcome: "selected", optionId: "reject" },
  });

  await page.getByRole("button", { name: "Open navigation" }).click();
  const navigation = page.getByRole("dialog", { name: "Workspace navigation" });
  await navigation.waitFor();
  assert(
    await navigation.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  );
  await navigation
    .getByRole("button", { name: "Sign out", exact: true })
    .focus();
  await page
    .getByRole("button", { name: "Open navigation" })
    .evaluate((element) => element.focus());
  assert(
    await navigation.evaluate((element) =>
      element.contains(document.activeElement),
    ),
    "modal navigation makes the underlying workspace inert",
  );
  // Native dialogs permit focus to browser chrome (document.body), never to
  // the covered application. The next Tab returns to the first dialog control.
  await page.keyboard.press("Tab");
  assert(
    await page.evaluate(
      () =>
        document.activeElement === document.body ||
        document.querySelector("dialog").contains(document.activeElement),
    ),
  );
  await page.keyboard.press("Tab");
  assert(
    await navigation.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  );
  await page.keyboard.press("Escape");
  await navigation.waitFor({ state: "hidden" });
  assert(
    await page
      .getByRole("button", { name: "Open navigation" })
      .evaluate((element) => element === document.activeElement),
  );
  await page.getByRole("button", { name: "Open navigation" }).click();
  await navigation.waitFor();
  await page.mouse.click(385, 400);
  await navigation.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await navigation.waitFor();
  await page.setViewportSize({ width: 1024, height: 768 });
  await navigation.waitFor({ state: "detached" });
  assert.equal(await page.locator(":modal").count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await navigation.waitFor();
  await assertTouchTargets(
    page,
    ".sidebar .icon-button, .back-to-agents, .conversation-option, .agent-option",
  );
  await page
    .getByRole("searchbox", { name: "Search conversations" })
    .fill("missing");
  await page.getByText("No matching loaded conversations").waitFor();
  await page.screenshot({ path: `${output}/navigation-mobile.png` });
  await page.getByRole("button", { name: "All agents" }).click();
  await page.getByRole("heading", { name: "Your agents" }).waitFor();
  await page.screenshot({ path: `${output}/agents-mobile.png` });
  assert.equal(await page.locator(".sidebar").count(), 0);
  await assertTouchTargets(
    page,
    ".chooser-actions .icon-button, .chooser-agent",
  );
  await page
    .getByRole("searchbox", { name: "Find an agent" })
    .fill("Operations");
  assert.equal(await page.locator(".chooser-agent").count(), 1);
  await page.getByRole("button", { name: "Clear search" }).click();
  assert.equal(await page.locator(".chooser-agent").count(), 2);
  // Long real-world names must reflow without hiding identity or state.
  agents[0].name = "Research and Operations 跨部门知识整理与长期经验学习助手";
  await page.reload();
  await page.getByRole("link", { name: /跨部门知识整理/ }).waitFor();
  for (const width of [320, 375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    const positions = await page
      .locator(".chooser-agent")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        }),
      );
    if (width <= 1050)
      assert(
        positions[0].x === positions[1].x &&
          positions[1].y >= positions[0].y + positions[0].height,
      );
    else
      assert(
        positions[0].y === positions[1].y && positions[1].x > positions[0].x,
      );
  }
  await page.setViewportSize({ width: 375, height: 844 });
  await page.screenshot({ path: `${output}/agents-long-label-mobile.png` });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("link", { name: /跨部门知识整理/ }).click();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await navigation.waitFor();
  await page.keyboard.press("Escape");
  await navigation.waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 768, height: 480 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await navigation.waitFor();
  await navigation
    .getByRole("button", { name: "Sign out", exact: true })
    .scrollIntoViewIfNeeded();
  const footer = await navigation
    .getByRole("button", { name: "Sign out", exact: true })
    .boundingBox();
  assert(footer && footer.y >= 0 && footer.y + footer.height <= 480);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 375, height: 844 });
  bootstrapUnavailable = true;
  await page.goto(`${origin}/workspace/`);
  await page.getByRole("heading", { name: "Workspace unavailable" }).waitFor();
  await assertTouchTargets(page, ".unavailable-retry");
  await page.screenshot({ path: `${output}/workspace-unavailable-mobile.png` });
  bootstrapUnavailable = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByRole("heading", { name: "Your agents" }).waitFor();
  agents.splice(0);
  await page.reload();
  await page.getByRole("heading", { name: "No Agent available" }).waitFor();
  await assertReadableText(page, [".unavailable-panel p"]);
  await page.screenshot({ path: `${output}/no-agents-mobile.png` });
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
      viewportWidths: [320, 375, 390, 768, 1024, 1440],
      shortViewportHeight: 480,
      prompts: 1,
      reloadResends: 0,
      browserErrors: 0,
      catalogRetryReconnects: 0,
      catalogPaging: "passed",
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
