import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { waitForDeletedResources } from "./deletion-resources.mjs";

function inventory(containers = [], volumes = []) {
  return Object.freeze({
    containers: Object.freeze([...containers]),
    volumes: Object.freeze([...volumes]),
    raw: Object.freeze({
      containers: containers.join("\n"),
      volumes: volumes.join("\n"),
    }),
  });
}

function fixture(rows = [inventory()]) {
  const f = { time: 1000, reads: [], waits: [], archives: [] };
  f.options = {
    deadline: 11_000,
    now: () => f.time,
    readInventory: (signal) => {
      const value = rows[Math.min(f.reads.length, rows.length - 1)];
      f.reads.push({ signal, value });
      return Promise.resolve(value);
    },
    wait: (ms, signal) => {
      assert(Number.isFinite(ms) && ms > 0);
      assert(ms <= f.options.deadline - f.time);
      signal?.throwIfAborted();
      f.waits.push({ ms, signal });
      f.time += ms;
      return Promise.resolve();
    },
    preserve: (evidence, error) => {
      f.archives.push({ evidence, error });
      return Promise.resolve();
    },
  };
  return f;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function observe(promise) {
  const operation = { settled: false };
  operation.done = promise.then(
    (value) => {
      operation.settled = true;
      return { value };
    },
    (error) => {
      operation.settled = true;
      return { error };
    },
  );
  return operation;
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Test actor did not settle")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("an already empty inventory succeeds and preserves the actual observation once", async () => {
  const original = inventory();
  const f = fixture([original]);

  assert.deepEqual(await waitForDeletedResources(f.options), {
    runtime_containers: 0,
    runtime_volumes: 0,
  });
  assert.equal(f.reads.length, 1);
  assert.equal(f.waits.length, 0);
  assert.equal(f.archives.length, 1);
  assert.equal(f.archives[0].error, undefined);
  assert.equal(f.archives[0].evidence.observations[0], original);
});

test("cleanup waits until both container and volume inventories are empty", async () => {
  const rows = [
    inventory(["runtime-1"], ["prepared-1"]),
    inventory([], ["prepared-1"]),
    inventory(),
  ];
  const f = fixture(rows);

  assert.deepEqual(await waitForDeletedResources(f.options), {
    runtime_containers: 0,
    runtime_volumes: 0,
  });
  assert.equal(f.reads.length, 3);
  assert.equal(f.waits.length, 2);
  assert.equal(f.archives.length, 1);
  assert.equal(f.archives[0].error, undefined);
  assert.deepEqual(f.archives[0].evidence.observations, rows);
  for (const [index, row] of rows.entries())
    assert.equal(f.archives[0].evidence.observations[index], row);
  assert.deepEqual(rows[0].containers, ["runtime-1"]);
  assert.deepEqual(rows[1].volumes, ["prepared-1"]);
  assert.deepEqual(rows[0].raw, {
    containers: "runtime-1",
    volumes: "prepared-1",
  });
});

test("persistent resources fail at the absolute deadline with all observations retained", async () => {
  const original = inventory([], ["prepared-1"]);
  const f = fixture([original]);
  const outcome = await observe(waitForDeletedResources(f.options)).done;

  assert(outcome.error instanceof Error);
  assert(
    f.time >= f.options.deadline,
    "resources must be observed until the deadline",
  );
  assert(f.reads.length > 1);
  assert(f.waits.length > 0);
  assert.equal(f.archives.length, 1);
  assert.equal(f.archives[0].error, outcome.error);
  assert.equal(f.archives[0].evidence.observations.length, f.reads.length);
  assert(f.archives[0].evidence.observations.every((row) => row === original));
});

test("an expired deadline cannot start another inventory read", async () => {
  const f = fixture();
  f.time = f.options.deadline;
  const outcome = await observe(waitForDeletedResources(f.options)).done;

  assert(outcome.error instanceof Error);
  assert.equal(f.reads.length, 0);
  assert.equal(f.waits.length, 0);
  assert.equal(f.archives.length, 1);
  assert.equal(f.archives[0].error, outcome.error);
  assert.deepEqual(f.archives[0].evidence.observations, []);
});

test("an empty inventory returned after the deadline is joined and cannot become success", async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  const original = inventory();
  let readJoined = false;
  f.options.readInventory = async () => {
    entered.resolve();
    try {
      await release.promise;
      return original;
    } finally {
      readJoined = true;
    }
  };
  const operation = observe(waitForDeletedResources(f.options));
  try {
    await bounded(entered.promise);
    f.time = f.options.deadline + 1;
    await nextTurn();
    assert.equal(operation.settled, false);
    assert.equal(f.archives.length, 0);
    release.resolve();
    const outcome = await bounded(operation.done);
    assert.equal(readJoined, true);
    assert(outcome.error instanceof Error);
    assert.equal(f.archives.length, 1);
    assert.equal(f.archives[0].error, outcome.error);
    assert.equal(f.archives[0].evidence.observations[0], original);
  } finally {
    release.resolve();
    await bounded(operation.done);
  }
});

test("an inventory read failure preserves its original error without retry", async () => {
  const f = fixture();
  const failure = new Error("Original Docker inventory read failed");
  let reads = 0;
  f.options.readInventory = () => {
    reads++;
    return Promise.reject(failure);
  };

  await assert.rejects(
    waitForDeletedResources(f.options),
    (error) => error === failure,
  );
  assert.equal(reads, 1);
  assert.equal(f.waits.length, 0);
  assert.equal(f.archives.length, 1);
  assert.equal(f.archives[0].error, failure);
  assert.deepEqual(f.archives[0].evidence.observations, []);
});

test("a failed later read preserves partial raw evidence and is not retried", async () => {
  const f = fixture();
  const original = inventory(["runtime-1"], []);
  const failure = new Error("Second Docker inventory read failed");
  let reads = 0;
  f.options.readInventory = () =>
    ++reads === 1 ? Promise.resolve(original) : Promise.reject(failure);

  await assert.rejects(
    waitForDeletedResources(f.options),
    (error) => error === failure,
  );
  assert.equal(reads, 2);
  assert.equal(f.waits.length, 1);
  assert.equal(f.archives.length, 1);
  assert.equal(f.archives[0].error, failure);
  assert.deepEqual(f.archives[0].evidence.observations, [original]);
  assert.equal(f.archives[0].evidence.observations[0], original);
});

test("pre-aborted ownership prevents reads and still archives the original reason", async () => {
  const f = fixture();
  const controller = new AbortController();
  const reason = new Error("Original deletion ownership lost");
  controller.abort(reason);
  f.options.signal = controller.signal;

  await assert.rejects(
    waitForDeletedResources(f.options),
    (error) => error === reason,
  );
  assert.equal(f.reads.length, 0);
  assert.equal(f.waits.length, 0);
  assert.equal(f.archives.length, 1);
  assert.equal(f.archives[0].error, reason);
});

test("ownership cancellation joins an already dispatched read before rejecting", async () => {
  const f = fixture();
  const controller = new AbortController();
  const reason = new Error("Ownership lost during Docker read");
  const entered = deferred();
  const release = deferred();
  const original = inventory();
  let readJoined = false;
  f.options.signal = controller.signal;
  f.options.readInventory = async (signal) => {
    entered.resolve(signal);
    try {
      await release.promise;
      return original;
    } finally {
      readJoined = true;
    }
  };
  const operation = observe(waitForDeletedResources(f.options));
  try {
    const readSignal = await bounded(entered.promise);
    controller.abort(reason);
    await nextTurn();
    assert.equal(readSignal.aborted, true);
    assert.equal(operation.settled, false);
    assert.equal(f.archives.length, 0);
    release.resolve();
    const outcome = await bounded(operation.done);
    assert.equal(readJoined, true);
    assert.equal(outcome.error, reason);
    assert.equal(f.waits.length, 0);
    assert.equal(f.archives.length, 1);
    assert.equal(f.archives[0].error, reason);
    assert.equal(f.archives[0].evidence.observations[0], original);
  } finally {
    controller.abort(reason);
    release.resolve();
    await bounded(operation.done);
  }
});

test("cancellation preserves an independent held read error without replacing the caller reason", async () => {
  const f = fixture();
  const controller = new AbortController();
  const reason = new Error("Original ownership cancellation");
  const readError = new Error("Independent Docker inventory read failed");
  const entered = deferred();
  const release = deferred();
  let reads = 0;
  let readJoined = false;
  f.options.signal = controller.signal;
  f.options.readInventory = async (signal) => {
    reads++;
    entered.resolve(signal);
    try {
      await release.promise;
      throw readError;
    } finally {
      readJoined = true;
    }
  };
  const operation = observe(waitForDeletedResources(f.options));
  try {
    const readSignal = await bounded(entered.promise);
    controller.abort(reason);
    await nextTurn();
    assert.equal(readSignal.aborted, true);
    assert.equal(operation.settled, false);
    assert.equal(readJoined, false);
    assert.equal(f.archives.length, 0);
    release.resolve();
    const outcome = await bounded(operation.done);
    assert.equal(readJoined, true);
    assert.equal(outcome.error, reason);
    assert.equal(reads, 1);
    assert.equal(f.waits.length, 0);
    assert.equal(f.archives.length, 1);
    assert.equal(f.archives[0].error, reason);
    assert.equal(f.archives[0].evidence.operationError, readError);
    assert.deepEqual(f.archives[0].evidence.observations, []);
  } finally {
    controller.abort(reason);
    release.resolve();
    await bounded(operation.done);
  }
});

test("ownership cancellation joins an active wait and prevents another read", async () => {
  const original = inventory([], ["prepared-1"]);
  const f = fixture([original]);
  const controller = new AbortController();
  const reason = new Error("Ownership lost while waiting for physical cleanup");
  const entered = deferred();
  const release = deferred();
  let waitJoined = false;
  f.options.signal = controller.signal;
  f.options.wait = async (ms, signal) => {
    assert(Number.isFinite(ms) && ms > 0);
    assert(ms <= f.options.deadline - f.time);
    entered.resolve(signal);
    try {
      await release.promise;
      f.time += ms;
    } finally {
      waitJoined = true;
    }
  };
  const operation = observe(waitForDeletedResources(f.options));
  try {
    const entry = await bounded(
      Promise.race([
        entered.promise.then((signal) => ({ signal })),
        operation.done.then(() => ({ endedBeforeWait: true })),
      ]),
    );
    assert.equal(
      entry.endedBeforeWait,
      undefined,
      "nonempty inventory requires a wait",
    );
    controller.abort(reason);
    await nextTurn();
    assert.equal(entry.signal.aborted, true);
    assert.equal(operation.settled, false);
    assert.equal(f.archives.length, 0);
    release.resolve();
    const outcome = await bounded(operation.done);
    assert.equal(waitJoined, true);
    assert.equal(outcome.error, reason);
    assert.equal(f.reads.length, 1);
    assert.equal(f.archives.length, 1);
    assert.equal(f.archives[0].error, reason);
    assert.equal(f.archives[0].evidence.observations[0], original);
  } finally {
    controller.abort(reason);
    release.resolve();
    await bounded(operation.done);
  }
});

test("private preservation must actually finish before returning success", async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  let archiveJoined = false;
  f.options.preserve = async (evidence, error) => {
    f.archives.push({ evidence, error });
    entered.resolve();
    try {
      await release.promise;
    } finally {
      archiveJoined = true;
    }
  };
  const operation = observe(waitForDeletedResources(f.options));
  try {
    await bounded(entered.promise);
    await nextTurn();
    assert.equal(operation.settled, false);
    release.resolve();
    const outcome = await bounded(operation.done);
    assert.equal(archiveJoined, true);
    assert.equal(outcome.error, undefined);
    assert.deepEqual(outcome.value, {
      runtime_containers: 0,
      runtime_volumes: 0,
    });
    assert.equal(f.archives.length, 1);
  } finally {
    release.resolve();
    await bounded(operation.done);
  }
});

test("private archive failure cannot be reported as successful physical cleanup", async () => {
  const f = fixture();
  const failure = new Error("Original private inventory archive failed");
  f.options.preserve = (evidence, error) => {
    f.archives.push({ evidence, error });
    return Promise.reject(failure);
  };

  await assert.rejects(
    waitForDeletedResources(f.options),
    (error) => error === failure,
  );
  assert.equal(f.archives.length, 1);
  assert.equal(f.archives[0].error, undefined);
  assert.equal(f.archives[0].evidence.observations[0], f.reads[0].value);
});

test("inventory and archive failures retain both original errors in order", async () => {
  const f = fixture();
  const failure = new Error("Original Docker read failed");
  const archive = new Error("Original private archive failed");
  f.options.readInventory = () => Promise.reject(failure);
  f.options.preserve = (evidence, error) => {
    f.archives.push({ evidence, error });
    return Promise.reject(archive);
  };

  await assert.rejects(waitForDeletedResources(f.options), (error) => {
    assert(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0], failure);
    assert.equal(error.errors[1], archive);
    return true;
  });
  assert.equal(f.archives.length, 1);
  assert.equal(f.archives[0].error, failure);
});
