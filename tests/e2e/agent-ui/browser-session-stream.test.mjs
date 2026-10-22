import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { verifyBrowserStreamRenewal } from "./browser-session-stream.mjs";

const phase = "c4-browser-hold-offline";
const config = {
  gateway: "http://gateway.test",
  model: "http://controlled-model.test",
};
const fixture = { agentID: "agent-renewal" };
const sessionId = "session-renewal";
const base = `/api/app/workspace/v1/agents/${fixture.agentID}`;

test(
  "renewal probe presses Enter once only after Send message becomes ready",
  { timeout: 5000 },
  async (t) => {
    const cutoff = new Error("owned test cutoff after the original Prompt ACK");
    const page = new RenewalPage({
      initialReady: false,
      acknowledgementCutoff: cutoff,
    });
    const abort = new AbortController();
    const endPage = () => page.closePending(t.signal.reason);
    t.signal.addEventListener("abort", endPage, { once: true });
    t.mock.method(globalThis, "fetch", async () => {
      assert.fail("the ACK cutoff must precede model or renewal requests");
    });
    const task = settled(
      verifyBrowserStreamRenewal({
        page,
        config,
        fixture,
        signal: AbortSignal.any([abort.signal, t.signal]),
      }),
    );
    let outcome;
    try {
      // The old probe presses Enter while editing is allowed but submission is
      // disabled. Race that actual action against a proper Send readiness read,
      // so a regression never leaves a fake response waiting for thirty seconds.
      const first = await Promise.race([
        page.initialSendRead.promise.then(() => "send-read"),
        page.prematureEnter.promise.then(() => "premature-enter"),
        task.then(() => "ended"),
      ]);
      if (first === "send-read") page.initialReady = true;
      else {
        abort.abort(cutoff);
        page.closePending(cutoff);
      }
      outcome = await task;
    } finally {
      abort.abort(cutoff);
      page.initialReady = true;
      page.closePending(cutoff);
      await task;
      t.signal.removeEventListener("abort", endPage);
    }
    assert.equal(outcome.status, "rejected");
    assert.equal(outcome.reason, cutoff);
    assert.deepEqual(page.enters, [{ key: "Enter", text: phase, ready: true }]);
    assert.equal(page.promptRequests, 1);
    assert.equal(page.initialSendReads > 0, true);
    assertProbeJoined(page);
  },
);

test(
  "renewal probe observes busy Stop and terminal Send while command editing remains enabled",
  { timeout: 5000 },
  async (t) => {
    const cutoff = new Error(
      "owned fixture cancellation after an invalid editor readiness read",
    );
    const page = new RenewalPage({ initialReady: true });
    const abort = new AbortController();
    const endPage = () => page.closePending(t.signal.reason);
    t.signal.addEventListener("abort", endPage, { once: true });
    t.mock.method(globalThis, "fetch", (url, options) =>
      page.fetch(url, options),
    );
    // This tests DOM orchestration, not real elapsed lease time. The fake mouse
    // advances only the monotonic clock; the production 95s/30s limits stay intact.
    t.mock.method(performance, "now", () => page.now);
    const task = settled(
      verifyBrowserStreamRenewal({
        page,
        config,
        fixture,
        signal: AbortSignal.any([abort.signal, t.signal]),
      }),
    );
    let outcome;
    try {
      const boundary = await Promise.race([
        page.terminalSendRead.promise.then(() => "terminal-send"),
        page.busyEditorRead.promise.then(() => "busy-editor"),
        page.terminalEditorRead.promise.then(() => "terminal-editor"),
        task.then(() => "ended"),
      ]);
      if (boundary === "terminal-send") page.terminalReady = true;
      else {
        abort.abort(cutoff);
        page.closePending(cutoff);
      }
      outcome = await task;
    } finally {
      abort.abort(cutoff);
      page.initialReady = true;
      page.terminalReady = true;
      page.closePending(cutoff);
      await task;
      t.signal.removeEventListener("abort", endPage);
    }
    assert.equal(outcome.status, "fulfilled", outcome.reason?.message);
    assert.deepEqual(page.enters, [{ key: "Enter", text: phase, ready: true }]);
    assert.equal(
      page.busyStopReads > 0,
      true,
      "the visible Stop control proves busy UI state",
    );
    assert.equal(
      page.editorDisabledReads,
      0,
      "a busy Agent deliberately retains its command editor",
    );
    assert.equal(
      page.terminalEditorReads,
      0,
      "an editable composer cannot prove terminal send readiness",
    );
    assert.equal(
      page.terminalSendReads >= 2,
      true,
      "terminal Send must first be observed disabled and then ready",
    );
    assert.equal(page.promptRequests, 1);
    assert.equal(page.releases, 1);
    assert.equal(page.mouseMoves, 1);
    assert.equal(page.activityBodies, 2);
    assert.equal(outcome.value.heldMs >= 95_000, true);
    assert.equal(outcome.value.observerRenewals, 1);
    assert.equal(outcome.value.genuineActivityReports, 2);
    assert.equal(outcome.value.modelRequests, 1);
    assert.equal(outcome.value.promptRequests, 1);
    assertProbeJoined(page);
  },
);

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function settled(promise) {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
}

function assertProbeJoined(page) {
  assert.equal(page.listenerCount("request"), 0);
  assert.equal(page.listenerCount("response"), 0);
  assert.equal(
    page.waiters.size,
    0,
    "the original fake Playwright response wait must settle",
  );
}

class RenewalPage extends EventEmitter {
  constructor({ initialReady, acknowledgementCutoff }) {
    super();
    this.initialReady = initialReady;
    this.acknowledgementCutoff = acknowledgementCutoff;
    this.terminalReady = false;
    this.stage = "draft";
    this.now = 0;
    this.text = "";
    this.enters = [];
    this.promptRequests = 0;
    this.releases = 0;
    this.mouseMoves = 0;
    this.activityBodies = 0;
    this.initialSendReads = 0;
    this.terminalSendReads = 0;
    this.busyStopReads = 0;
    this.editorDisabledReads = 0;
    this.terminalEditorReads = 0;
    this.initialSendRead = deferred();
    this.terminalSendRead = deferred();
    this.prematureEnter = deferred();
    this.busyEditorRead = deferred();
    this.terminalEditorRead = deferred();
    this.waiters = new Set();
    this.mouse = { move: async () => this.quietMouseMove() };
    this.composer = {
      // Control commands remain editable during a Run and after reply delivery,
      // even while the current View still forbids the next ordinary Prompt.
      isEnabled: async () => {
        if (this.stage === "terminal") {
          this.terminalEditorReads++;
          this.terminalEditorRead.resolve();
        }
        return true;
      },
      isDisabled: async () => {
        this.editorDisabledReads++;
        this.busyEditorRead.resolve();
        return false;
      },
      fill: async (text) => {
        this.text = text;
      },
      press: async (key) => this.press(key),
    };
  }

  getByRole(role, { name, exact }) {
    assert.equal(exact, true);
    if (role === "combobox" && name === "Message") return this.composer;
    assert.equal(role, "button");
    if (name === "New conversation")
      return {
        click: async () => {
          this.stage = "draft";
        },
      };
    if (name === "Send message")
      return {
        isEnabled: async () => this.sendEnabled(),
        isDisabled: async () => !this.sendEnabled(),
        isVisible: async () => this.stage !== "busy",
      };
    if (name === "Stop operation") {
      const observed = () => {
        this.busyStopReads++;
        return this.stage === "busy";
      };
      return {
        isVisible: async () => observed(),
        isEnabled: async () => observed(),
        waitFor: async () => assert.equal(observed(), true),
      };
    }
    assert.fail(`unexpected visible control: ${name}`);
  }

  sendEnabled() {
    if (this.stage === "draft") {
      this.initialSendReads++;
      this.initialSendRead.resolve();
      return this.initialReady;
    }
    if (this.stage === "terminal") {
      this.terminalSendReads++;
      this.terminalSendRead.resolve();
      return this.terminalReady;
    }
    return false;
  }

  waitForResponse(predicate) {
    return new Promise((resolve, reject) => {
      this.waiters.add({ predicate, resolve, reject });
    });
  }

  press(key) {
    const ready = this.stage === "draft" && this.initialReady;
    this.enters.push({ key, text: this.text, ready });
    assert.equal(key, "Enter");
    if (!ready) {
      this.prematureEnter.resolve();
      return;
    }
    this.promptRequests++;
    this.deliver(
      `${base}/sessions/${sessionId}/prompts`,
      "POST",
      202,
      "application/json",
      async () => {
        if (this.acknowledgementCutoff) throw this.acknowledgementCutoff;
        this.stage = "busy";
        return { operationId: "intent-renewal" };
      },
    );
    this.observer();
  }

  deliver(path, method, status, contentType, json = async () => ({})) {
    const url = config.gateway + path;
    const request = { url: () => url, method: () => method };
    const response = {
      url: () => url,
      request: () => request,
      status: () => status,
      headers: () => ({ "content-type": contentType }),
      json,
    };
    this.emit("request", request);
    this.emit("response", response);
    for (const waiter of [...this.waiters]) {
      try {
        if (!waiter.predicate(response)) continue;
        this.waiters.delete(waiter);
        waiter.resolve(response);
      } catch (error) {
        this.waiters.delete(waiter);
        waiter.reject(error);
      }
    }
  }

  observer() {
    this.deliver(
      `${base}/events?sessionId=${sessionId}`,
      "GET",
      200,
      "text/event-stream",
    );
  }

  quietMouseMove() {
    assert.equal(this.stage, "busy");
    this.mouseMoves++;
    this.now += 95_001;
    this.observer();
    for (let index = 0; index < 2; index++) {
      this.now++;
      this.deliver(
        "/api/session/activity",
        "POST",
        200,
        "application/json",
        async () => {
          this.activityBodies++;
          return {
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            idle_expires_at: new Date(Date.now() + 30_000).toISOString(),
            activity_interval_ms: 1000,
          };
        },
      );
    }
  }

  async fetch(url, options) {
    options.signal.throwIfAborted();
    if (String(url) === `${config.model}/status`)
      return {
        status: 200,
        json: async () => ({
          errors: [],
          pending: this.releases ? [] : [phase],
          requests: [{ phase, disconnected: false }],
        }),
      };
    assert.equal(String(url), `${config.model}/release/${phase}`);
    assert.equal(options.method, "POST");
    this.releases++;
    this.now += 100;
    this.stage = "released";
    return { status: 200 };
  }

  locator(selector) {
    assert.equal(selector, ".message-assistant .message-content");
    return {
      filter: ({ hasText }) => {
        assert.equal(hasText, `${phase} completed`);
        return {
          waitFor: async () => {
            assert.equal(this.stage, "released");
            this.stage = "terminal";
          },
        };
      },
    };
  }

  closePending(reason) {
    for (const waiter of this.waiters) waiter.reject(reason);
    this.waiters.clear();
  }
}
