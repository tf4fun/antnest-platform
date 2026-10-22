import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { sendBrowserPrompt } from "./browser-prompt-send.mjs";

test("Prompt waits for visible and enabled Send before installing its response wait or pressing Enter", async () => {
  const fixture = promptFixture();
  let polls = 0;
  const work = startPrompt(fixture, async (read, label) => {
    polls++;
    assert.equal(typeof label, "string");
    assert.notEqual(label.length, 0);
    assert.deepEqual(fixture.fills, [fixture.phase]);
    assert.equal(await fixture.composer.isEnabled(), true);

    fixture.button.visible = false;
    fixture.button.enabled = true;
    assert.equal(await read(), false, "an invisible Send cannot admit Enter");
    assert.equal(fixture.waits.length, 0);
    assert.equal(fixture.presses.length, 0);

    fixture.button.visible = true;
    fixture.button.enabled = false;
    assert.equal(await read(), false, "an enabled editor does not enable Send");
    assert.equal(fixture.waits.length, 0);
    assert.equal(fixture.presses.length, 0);

    fixture.button.enabled = true;
    assert.equal(await read(), true);
  });
  try {
    await reachDispatchOrOutcome(fixture, work);
    fixture.press.resolve();
    fixture.response.resolve(fixture.reply);
  } finally {
    await joinFixture(fixture, work);
  }

  const result = await work.result;
  assert.equal(result.status, "fulfilled", result.reason?.message);
  assert.equal(
    result.value,
    fixture.reply,
    "return the actual Playwright response",
  );
  assert.equal(polls, 1);
  assert.deepEqual(fixture.presses, ["Enter"]);
  assert.equal(fixture.waits.length, 1);
  assert.equal(fixture.waits[0].matches, fixture.matchesResponse);
  assert.deepEqual(fixture.waits[0].options, { timeout: 30_000 });
  assert.deepEqual(
    fixture.events.filter((event) => ["fill", "wait", "press"].includes(event)),
    ["fill", "wait", "press"],
  );
});

test("Prompt readiness failure preserves its cause without registering a response wait or Enter", async () => {
  const fixture = promptFixture();
  const failure = new Error("caller-owned admission poll failed");
  const work = startPrompt(fixture, async () => {
    throw failure;
  });
  try {
    // A baseline that ignores poll reaches dispatch instead. Release that work
    // in finally so its behavior fails assertions without waiting thirty seconds.
    await reachDispatchOrOutcome(fixture, work);
  } finally {
    await joinFixture(fixture, work);
  }

  const result = await work.result;
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, failure);
  assert.deepEqual(fixture.fills, [fixture.phase]);
  assert.deepEqual(fixture.waits, []);
  assert.deepEqual(fixture.presses, []);
});

test("Prompt joins both failed Playwright operations and preserves both original errors", async () => {
  const fixture = promptFixture();
  const pressFailure = new Error("original Enter failure");
  const responseFailure = new Error("original response failure");
  const work = startPrompt(fixture, readyPoll);
  let waitedForPress = false;
  try {
    await reachDispatchOrOutcome(fixture, work);
    assert.equal(fixture.waits.length, 1);
    assert.deepEqual(fixture.presses, ["Enter"]);
    fixture.response.reject(responseFailure);
    await fixture.responseOutcome;
    await nextTurn();
    waitedForPress = !work.finished;
    fixture.press.reject(pressFailure);
    await work.result;
  } finally {
    await joinFixture(fixture, work);
  }

  assert.equal(
    waitedForPress,
    true,
    "a response failure cannot abandon the held Enter",
  );
  const result = await work.result;
  assert.equal(result.status, "rejected");
  assert.equal(result.reason instanceof AggregateError, true);
  assert.deepEqual(result.reason.errors, [pressFailure, responseFailure]);
  assert.equal((await fixture.pressOutcome).reason, pressFailure);
  assert.equal((await fixture.responseOutcome).reason, responseFailure);
});

test("Prompt Enter failure waits for the original held response before rejecting", async () => {
  const fixture = promptFixture();
  const failure = new Error("original Enter failure with response still held");
  const work = startPrompt(fixture, readyPoll);
  let waitedForResponse = false;
  try {
    await reachDispatchOrOutcome(fixture, work);
    assert.equal(fixture.waits.length, 1);
    assert.deepEqual(fixture.presses, ["Enter"]);
    fixture.press.reject(failure);
    await fixture.pressOutcome;
    await nextTurn();
    waitedForResponse = !work.finished;
    fixture.response.resolve(fixture.reply);
    await work.result;
  } finally {
    await joinFixture(fixture, work);
  }

  assert.equal(
    waitedForResponse,
    true,
    "Enter failure cannot abandon the actual response wait",
  );
  const result = await work.result;
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, failure);
  assert.deepEqual(await fixture.responseOutcome, {
    status: "fulfilled",
    value: fixture.reply,
  });
  assert.deepEqual(fixture.presses, ["Enter"]);
});

function promptFixture() {
  const fixture = {
    phase: "explicit-new-prompt",
    reply: { status: () => 202 },
    button: { visible: true, enabled: true },
    fills: [],
    presses: [],
    waits: [],
    events: [],
    press: deferred(),
    response: deferred(),
    pressEntered: deferred(),
    waitEntered: deferred(),
  };
  // Observe each owned Promise from creation, including early rejections. The
  // same original Promises are returned to the helper and joined in finally.
  fixture.pressOutcome = settled(fixture.press.promise);
  fixture.responseOutcome = settled(fixture.response.promise);
  fixture.matchesResponse = (response) => response === fixture.reply;
  fixture.composer = {
    isEnabled: async () => true,
    fill: async (phase) => {
      fixture.events.push("fill");
      fixture.fills.push(phase);
    },
    press: (key) => {
      fixture.events.push("press");
      fixture.presses.push(key);
      fixture.pressEntered.resolve();
      return fixture.press.promise;
    },
  };
  fixture.page = {
    getByRole: (role, options) => {
      assert.equal(role, "button");
      assert.deepEqual(options, { name: "Send message", exact: true });
      return {
        isVisible: async () => fixture.button.visible,
        isEnabled: async () => fixture.button.enabled,
      };
    },
    waitForResponse: (matches, options) => {
      fixture.events.push("wait");
      fixture.waits.push({ matches, options });
      fixture.waitEntered.resolve();
      return fixture.response.promise;
    },
  };
  return fixture;
}

function startPrompt(fixture, poll) {
  const work = { finished: false };
  work.result = settled(
    Promise.resolve().then(() =>
      sendBrowserPrompt({
        page: fixture.page,
        composer: fixture.composer,
        phase: fixture.phase,
        matchesResponse: fixture.matchesResponse,
        poll,
      }),
    ),
  ).then((result) => {
    work.finished = true;
    return result;
  });
  return work;
}

async function readyPoll(read) {
  assert.equal(await read(), true);
}

async function reachDispatchOrOutcome(fixture, work) {
  await Promise.race([
    fixture.waitEntered.promise,
    fixture.pressEntered.promise,
    work.result,
  ]);
  await nextTurn();
}

async function joinFixture(fixture, work) {
  fixture.press.resolve();
  fixture.response.resolve(fixture.reply);
  fixture.pressEntered.resolve();
  fixture.waitEntered.resolve();
  await Promise.all([
    work.result,
    fixture.pressOutcome,
    fixture.responseOutcome,
    fixture.pressEntered.promise,
    fixture.waitEntered.promise,
  ]);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function settled(promise) {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
}
