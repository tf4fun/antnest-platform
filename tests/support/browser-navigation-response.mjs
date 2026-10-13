import assert from "node:assert/strict";

async function bounded(operation, timeout, message) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Inspect the original response after an application-triggered navigation. A
// separate CDP session must read its own durable buffer, not Playwright's buffer
// in the old renderer. This observer never intercepts or replays requests.
export async function captureNavigationResponse(
  page,
  { url, method = "POST", timeout = 10_000 },
  action,
) {
  const ready = Promise.withResolvers();
  // A failed action may finish before the network observer is awaited.
  void ready.promise.catch(() => {});
  let session,
    requestId,
    protocolResponse,
    response,
    finished = false,
    stopped = false,
    failure;
  const fail = (error) => {
    failure ??= error;
    ready.reject(error);
  };
  const settle = () => {
    if (requestId && protocolResponse && response && finished) ready.resolve();
  };
  const guard = (fn) => (event) => {
    try {
      fn(event);
    } catch (error) {
      fail(error);
    }
  };
  const request = guard((event) => {
    if (event.requestId === requestId && event.redirectResponse)
      throw new Error("browser response capture refuses redirects");
    if (event.request.url !== url || event.request.method !== method) return;
    assert(
      !requestId,
      "browser response capture saw more than one matching request",
    );
    assert(
      !event.redirectResponse,
      "browser response capture refuses redirects",
    );
    requestId = event.requestId;
  });
  const received = guard((event) => {
    if (event.requestId !== requestId) return;
    assert.equal(event.response.url, url, "browser response URL changed");
    protocolResponse = event.response;
    settle();
  });
  const completed = guard((event) => {
    if (event.requestId !== requestId) return;
    finished = true;
    settle();
  });
  const failed = (event) => {
    if (event.requestId === requestId)
      fail(new Error("browser response capture request failed"));
  };
  const playwrightResponse = guard((value) => {
    if (value.url() !== url || value.request().method() !== method) return;
    assert(!response, "browser response capture saw duplicate responses");
    response = value;
    settle();
  });
  const closed = () => fail(new Error("browser response capture page closed"));
  const listeners = [
    ["close", () => fail(new Error("browser response capture session closed"))],
    ["Network.requestWillBeSent", request],
    ["Network.responseReceived", received],
    ["Network.loadingFinished", completed],
    ["Network.loadingFailed", failed],
  ];
  page.on("response", playwrightResponse);
  page.on("close", closed);
  try {
    return await bounded(
      (async () => {
        session = await page.context().newCDPSession(page);
        if (stopped) return;
        for (const [name, handler] of listeners) session.on(name, handler);
        await session.send("Network.enable");
        if (stopped) return;
        await session.send("Network.configureDurableMessages", {
          maxTotalBufferSize: 8 * 1024 * 1024,
          maxResourceBufferSize: 1024 * 1024,
        });
        if (stopped) return;
        await Promise.all([ready.promise, action()]);
        if (failure) throw failure;
        assert.equal(
          protocolResponse.status,
          response.status(),
          "browser response status mismatch",
        );
        const trace =
          Object.entries(protocolResponse.headers).find(
            ([name]) => name.toLowerCase() === "x-antnest-trace-id",
          )?.[1] ?? null;
        assert.equal(
          trace,
          await response.headerValue("x-antnest-trace-id"),
          "browser response trace mismatch",
        );
        const data = await session.send("Network.getResponseBody", {
          requestId,
        });
        const body = Buffer.from(
          data.body,
          data.base64Encoded ? "base64" : "utf8",
        );
        assert(
          body.length <= 1024 * 1024,
          "browser response capture body exceeds limit",
        );
        if (failure) throw failure;
        return { response, body };
      })(),
      timeout,
      "browser response capture deadline exceeded",
    );
  } catch (error) {
    fail(error);
    throw error;
  } finally {
    stopped = true;
    for (const [name, handler] of listeners) session?.off(name, handler);
    page.off("response", playwrightResponse);
    page.off("close", closed);
    try {
      if (session)
        await bounded(
          session.detach(),
          2_000,
          "browser response detach deadline exceeded",
        );
    } catch (error) {
      if (!page.isClosed()) {
        failure ??= error;
        throw error;
      }
    } finally {
      // Closing the failed page also retires a CDP attachment that finishes
      // after its deadline, and stops an action still waiting on the network.
      if (failure && !page.isClosed())
        await bounded(
          page.close(),
          2_000,
          "browser response cleanup deadline exceeded",
        );
    }
  }
}
