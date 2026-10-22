import assert from "node:assert/strict";
import test from "node:test";
import { fixture, summary } from "./foundation-business-fixtures.mjs";

const url = new URL("./foundation-business-collection.mjs", import.meta.url);
const { collectFoundationBusinessEvidence: collect } = await import(url).catch(
  (error) => {
    if (error.code !== "ERR_MODULE_NOT_FOUND" || error.url !== url.href)
      throw error;
    return {};
  },
);
const requireAPI = () => assert.equal(typeof collect, "function");
const turn = () => new Promise((resolve) => setImmediate(resolve));
const outcome = (promise) =>
  promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );

async function within(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Foundation test gate timed out")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function entered(gate, task) {
  const result = await within(
    Promise.race([
      gate.promise.then(() => ({ entered: true })),
      task.then(() => ({ entered: false })),
    ]),
  );
  assert.equal(
    result.entered,
    true,
    "collector settled before the expected gate",
  );
}

function environment() {
  const source = fixture();
  const { audits, ...input } = source;
  const routes = [];
  for (const audit of audits) {
    routes.push({
      path:
        "/api/admin/execution-audits?agent_id=" +
        encodeURIComponent(input.agent_id) +
        "&session_id=" +
        encodeURIComponent(audit.session_id) +
        "&limit=100",
      body: audit.page,
    });
    for (const saved of audit.all) {
      const path =
        "/api/admin/execution-audits/" + encodeURIComponent(saved.run.run_id);
      routes.push({ path, body: saved.run });
      routes.push({ path: path + "/events?limit=100", body: saved.events });
    }
  }
  const owner = new AbortController();
  const calls = [];
  const preserved = [];
  let active = 0;
  const readJSON = async (path, { signal }) => {
    assert.equal(signal, owner.signal, "read lost its ownership signal");
    assert.equal(active, 0, "audit reads must be serial");
    assert.equal(
      path,
      routes[calls.length]?.path,
      "wrong original audit route",
    );
    calls.push(path);
    active++;
    try {
      await Promise.resolve();
      return routes[calls.length - 1].body;
    } finally {
      active--;
    }
  };
  const preserve = (evidence, failure) => {
    preserved.push({ evidence, failure });
    return Promise.resolve();
  };
  return {
    source,
    input,
    routes,
    owner,
    calls,
    preserved,
    readJSON,
    preserve,
    options: { readJSON, preserve, signal: owner.signal },
  };
}

test("Foundation collector serially reads all six original Audit responses and preserves them untouched", async () => {
  requireAPI();
  const f = environment();
  const original = structuredClone(f.source);
  const result = await collect(f.input, f.options);
  assert.deepEqual(
    f.calls,
    f.routes.map((route) => route.path),
  );
  assert.equal(f.calls.length, 6);
  assert.deepEqual(result.summary, summary);
  assert.deepEqual(result.evidence, f.source);
  assert.deepEqual(
    f.source,
    original,
    "collector changed original input or HTTP bodies",
  );
  for (const [index, audit] of result.evidence.audits.entries()) {
    const actual = f.source.audits[index];
    assert.equal(
      audit.page,
      actual.page,
      "original list response was replaced",
    );
    for (const [runIndex, saved] of audit.all.entries()) {
      assert.equal(saved.run, actual.all[runIndex].run);
      assert.equal(saved.events, actual.all[runIndex].events);
    }
  }
  assert.equal(f.preserved.length, 1);
  assert.equal(f.preserved[0].evidence, result.evidence);
  assert.equal(f.preserved[0].failure, undefined);
});

test("Foundation collector does not dispatch later reads while the first real read is held", async () => {
  requireAPI();
  const f = environment();
  const gate = Promise.withResolvers();
  const release = Promise.withResolvers();
  let settled = false;
  const task = outcome(
    collect(f.input, {
      ...f.options,
      readJSON: async (path, options) => {
        if (path === f.routes[0].path) {
          const body = await f.readJSON(path, options);
          gate.resolve();
          await release.promise;
          return body;
        }
        return f.readJSON(path, options);
      },
    }),
  ).then((result) => {
    settled = true;
    return result;
  });
  try {
    await entered(gate, task);
    await turn();
    assert.equal(settled, false);
    assert.deepEqual(f.calls, [f.routes[0].path]);
    assert.equal(f.preserved.length, 0);
    release.resolve();
    const result = await within(task);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.value.summary, summary);
  } finally {
    release.resolve();
    f.owner.abort(new Error("test finished"));
    await within(task);
  }
});

test("a read failure preserves its original identity and every response already captured exactly once", async () => {
  requireAPI();
  const f = environment();
  const readError = new Error("original event HTTP failure");
  const result = await outcome(
    collect(f.input, {
      ...f.options,
      readJSON: (path, options) => {
        if (path === f.routes[2].path) {
          f.calls.push(path);
          return Promise.reject(readError);
        }
        return f.readJSON(path, options);
      },
    }),
  );
  assert.equal(result.error, readError);
  assert.deepEqual(
    f.calls,
    f.routes.slice(0, 3).map((route) => route.path),
  );
  assert.equal(f.preserved.length, 1);
  const partial = f.preserved[0].evidence;
  assert.equal(f.preserved[0].failure, readError);
  assert.equal(partial.agent_id, f.input.agent_id);
  assert.deepEqual(partial.private_connections, f.input.private_connections);
  assert.equal(partial.audits[0].page, f.source.audits[0].page);
  assert.equal(partial.audits[0].all[0].run, f.source.audits[0].all[0].run);
  assert(
    partial.audits[0].all[0].events == null,
    "unread events became evidence",
  );
  const denied = partial.audits.find(
    (audit) => audit.session_id === f.source.audits[1].session_id,
  );
  assert(
    denied?.page == null,
    "unread rejected Session became a complete page",
  );
});

test("collector invokes the real business inspector and preserves its failed evidence rather than passing it", async () => {
  requireAPI();
  const f = environment();
  f.source.audits[0].all[0].run.state = "running";
  const result = await outcome(collect(f.input, f.options));
  assert(result.error instanceof Error);
  assert.equal(result.value, undefined);
  assert.equal(f.calls.length, 6);
  assert.equal(f.preserved.length, 1);
  assert.equal(f.preserved[0].failure, result.error);
  assert.equal(f.preserved[0].evidence.audits[0].all[0].run.state, "running");
});

test("a truncated list page remains a hard failure and is archived before any continuation", async () => {
  requireAPI();
  const f = environment();
  f.source.audits[0].page.next_cursor = "unread-history";
  const result = await outcome(collect(f.input, f.options));
  assert(result.error instanceof Error);
  assert.equal(result.value, undefined);
  assert.deepEqual(f.calls, [f.routes[0].path]);
  assert.equal(f.preserved.length, 1);
  assert.equal(f.preserved[0].failure, result.error);
  assert.equal(f.preserved[0].evidence.audits[0].page, f.source.audits[0].page);
  assert.equal(f.source.audits[0].page.next_cursor, "unread-history");
});

test("business archive failure remains hard after all reads and successful inspection", async () => {
  requireAPI();
  const f = environment();
  const archiveError = new Error("original private archive failure");
  const result = await outcome(
    collect(f.input, {
      ...f.options,
      preserve: (evidence, failure) => {
        f.preserved.push({ evidence, failure });
        return Promise.reject(archiveError);
      },
    }),
  );
  assert.equal(result.error, archiveError);
  assert.equal(result.value, undefined);
  assert.equal(f.calls.length, 6);
  assert.equal(f.preserved.length, 1);
  assert.equal(f.preserved[0].failure, undefined);
  assert.deepEqual(f.preserved[0].evidence, f.source);
});

test("read and archive failures retain both original errors in deterministic order", async () => {
  requireAPI();
  const f = environment();
  const readError = new Error("original list HTTP failure");
  const archiveError = new Error("original partial archive failure");
  const result = await outcome(
    collect(f.input, {
      ...f.options,
      readJSON: (path) => {
        f.calls.push(path);
        return Promise.reject(readError);
      },
      preserve: (evidence, failure) => {
        f.preserved.push({ evidence, failure });
        return Promise.reject(archiveError);
      },
    }),
  );
  assert(result.error instanceof AggregateError);
  assert.deepEqual(result.error.errors, [readError, archiveError]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.preserved.length, 1);
  assert.equal(f.preserved[0].failure, readError);
});

test("pre-aborted ownership prevents all reads but still preserves partial evidence once", async () => {
  requireAPI();
  const f = environment();
  const lost = new Error("original ownership loss");
  f.owner.abort(lost);
  const result = await outcome(collect(f.input, f.options));
  assert.equal(result.error, lost);
  assert.deepEqual(f.calls, []);
  assert.equal(f.preserved.length, 1);
  assert.equal(f.preserved[0].failure, lost);
  assert.deepEqual(
    f.preserved[0].evidence.private_connections,
    f.input.private_connections,
  );
});

test("ownership loss waits for the outstanding read's actual cancellation finally before archiving or returning", async () => {
  requireAPI();
  const f = environment();
  const started = Promise.withResolvers();
  const cleaning = Promise.withResolvers();
  const release = Promise.withResolvers();
  const lost = new Error("original ownership loss during HTTP read");
  let readJoined = false;
  let settled = false;
  const task = outcome(
    collect(f.input, {
      ...f.options,
      readJSON: async (path, { signal }) => {
        assert.equal(signal, f.owner.signal);
        f.calls.push(path);
        let abort;
        try {
          await new Promise((_, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            started.resolve();
            if (signal.aborted) abort();
          });
        } finally {
          signal.removeEventListener("abort", abort);
          cleaning.resolve();
          await release.promise;
          readJoined = true;
        }
      },
      preserve: (evidence, failure) => {
        assert.equal(
          readJoined,
          true,
          "archive began before HTTP cleanup joined",
        );
        return f.preserve(evidence, failure);
      },
    }),
  ).then((result) => {
    settled = true;
    return result;
  });
  try {
    await entered(started, task);
    f.owner.abort(lost);
    await entered(cleaning, task);
    await turn();
    assert.equal(
      settled,
      false,
      "collector returned with HTTP cleanup still held",
    );
    assert.equal(f.preserved.length, 0);
    release.resolve();
    const result = await within(task);
    assert.equal(result.error, lost);
    assert.equal(readJoined, true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.preserved.length, 1);
    assert.equal(f.preserved[0].failure, lost);
  } finally {
    release.resolve();
    f.owner.abort(lost);
    await within(task);
  }
});

test("successful collection awaits the actual private archive before returning its result", async () => {
  requireAPI();
  const f = environment();
  const gate = Promise.withResolvers();
  const release = Promise.withResolvers();
  let archiveJoined = false;
  let settled = false;
  const task = outcome(
    collect(f.input, {
      ...f.options,
      preserve: async (evidence, failure) => {
        f.preserved.push({ evidence, failure });
        gate.resolve();
        await release.promise;
        archiveJoined = true;
      },
    }),
  ).then((result) => {
    settled = true;
    return result;
  });
  try {
    await entered(gate, task);
    await turn();
    assert.equal(f.calls.length, 6);
    assert.equal(settled, false);
    assert.equal(archiveJoined, false);
    release.resolve();
    const result = await within(task);
    assert.equal(result.error, undefined);
    assert.equal(archiveJoined, true);
    assert.deepEqual(result.value.summary, summary);
    assert.equal(f.preserved.length, 1);
  } finally {
    release.resolve();
    f.owner.abort(new Error("test finished"));
    await within(task);
  }
});

test("ownership loss during a held archive is not swallowed and still joins the archive", async () => {
  requireAPI();
  const f = environment();
  const gate = Promise.withResolvers();
  const release = Promise.withResolvers();
  const lost = new Error("original ownership loss during archive");
  let archiveJoined = false;
  let settled = false;
  const task = outcome(
    collect(f.input, {
      ...f.options,
      preserve: async (evidence, failure) => {
        f.preserved.push({ evidence, failure });
        gate.resolve();
        await release.promise;
        archiveJoined = true;
      },
    }),
  ).then((result) => {
    settled = true;
    return result;
  });
  try {
    await entered(gate, task);
    f.owner.abort(lost);
    await turn();
    assert.equal(settled, false);
    assert.equal(archiveJoined, false);
    release.resolve();
    const result = await within(task);
    assert.equal(result.error, lost);
    assert.equal(result.value, undefined);
    assert.equal(archiveJoined, true);
    assert.equal(f.preserved.length, 1);
  } finally {
    release.resolve();
    f.owner.abort(lost);
    await within(task);
  }
});

test("missing original new-session receipt cannot be replaced by unverified Session labels", async () => {
  requireAPI();
  const f = environment();
  delete f.input.private_connections[0].evidence[0].requestReceipt;
  const result = await outcome(collect(f.input, f.options));
  assert(result.error instanceof Error);
  assert.equal(result.value, undefined);
  assert.deepEqual(f.calls, []);
  assert.equal(f.preserved.length, 1);
  assert.equal(f.preserved[0].failure, result.error);
});
