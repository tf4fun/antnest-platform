// This function is serialized into the owned gate container. Its deadline
// covers headers and the complete body; no host-published port is involved.
async function containerRequest({ action, body }) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 5_000);
  let receipt;
  try {
    const response = await fetch(`http://127.0.0.1:8080/__fault/${action}`, {
      method: action === "state" ? "GET" : "POST",
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
      redirect: "error",
      signal: abort.signal,
    });
    const rawBody = await response.text();
    JSON.parse(rawBody);
    receipt = { ok: true, status: response.status, rawBody };
  } catch {
    receipt = {
      ok: false,
      error: abort.signal.aborted
        ? "gate_control_timeout"
        : "gate_control_failed",
    };
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
  // Flush the entire private receipt before exiting. A failed request is an
  // explicit receipt, not success; exiting also retires this fetch's sockets.
  process.stdout.write(JSON.stringify(receipt), (error) =>
    process.exit(error ? 1 : 0),
  );
}

const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keysAre = (value, keys) =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

function inputFor(action, body) {
  if (action === "state" && body === undefined) return { action };
  if (
    (action === "arm" || action === "release") &&
    keysAre(body, ["intentId"]) &&
    typeof body.intentId === "string" &&
    body.intentId.length > 0
  )
    return { action, body: { intentId: body.intentId } };
  throw new Error("Invalid gate control action or body");
}

function readReceipt(raw) {
  let receipt;
  try {
    receipt = JSON.parse(raw);
  } catch {
    throw new Error("Invalid gate control exec receipt");
  }
  if (
    keysAre(receipt, ["ok", "error"]) &&
    receipt.ok === false &&
    typeof receipt.error === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/u.test(receipt.error)
  )
    throw new Error(`Gate control request failed: ${receipt.error}`);
  if (
    !keysAre(receipt, ["ok", "status", "rawBody"]) ||
    receipt.ok !== true ||
    !Number.isInteger(receipt.status) ||
    receipt.status < 100 ||
    receipt.status > 599 ||
    typeof receipt.rawBody !== "string"
  )
    throw new Error("Invalid gate control exec receipt");
  let body;
  try {
    body = JSON.parse(receipt.rawBody);
  } catch {
    throw new Error("Invalid gate control response JSON");
  }
  return { status: receipt.status, rawBody: receipt.rawBody, body };
}

export function createGateControl({ exec, signal }) {
  if (typeof exec !== "function")
    throw new Error("Gate control requires owned execution");
  const tasks = new Set();
  const request = async (action, { body, cleanup = false } = {}) => {
    const input = inputFor(action, body);
    if (!cleanup) signal?.throwIfAborted();
    const script = `await (${containerRequest.toString()})(${JSON.stringify(input)});`;
    const task = (async () => {
      let raw;
      try {
        // Do not race the exec with parent abort. Once started, it owns a
        // separate five-second request budget and must actually finish.
        raw = await exec(script);
      } catch {
        if (!cleanup) signal?.throwIfAborted();
        throw new Error("Gate control exec failed");
      }
      if (!cleanup) signal?.throwIfAborted();
      return readReceipt(raw);
    })();
    tasks.add(task);
    void task.then(
      () => tasks.delete(task),
      () => tasks.delete(task),
    );
    return task;
  };
  return {
    request,
    async join() {
      while (tasks.size) await Promise.allSettled([...tasks]);
    },
  };
}
