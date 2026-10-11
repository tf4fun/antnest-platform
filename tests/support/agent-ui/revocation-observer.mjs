import assert from "node:assert/strict";

const storageKey = "antnest-test-external-revocation";

// Observe browser dispatch and actual consumption of the revocation field.
// Network response events can precede body consumption; navigation can discard
// their timing. Only method/path/sequence are retained across the test redirect.
export async function installRevocationObserver(context, target) {
  await context.addInitScript(
    ({ target, storageKey }) => {
      const originalFetch = globalThis.fetch.bind(globalThis);
      const record = (event) => {
        const events = JSON.parse(sessionStorage.getItem(storageKey) ?? "[]");
        events.push({ ...event, sequence: events.length + 1 });
        sessionStorage.setItem(storageKey, JSON.stringify(events));
      };
      globalThis.fetch = async (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : input,
          location.href,
        );
        const method = (
          init?.method ?? (input instanceof Request ? input.method : "GET")
        ).toUpperCase();
        if (url.origin === location.origin && url.pathname.startsWith("/api/"))
          record({ type: "request", method, path: url.pathname });
        const response = await originalFetch(input, init);
        if (
          url.origin === location.origin &&
          url.pathname === target &&
          method === "DELETE" &&
          response.ok
        ) {
          const originalJSON = response.json.bind(response);
          response.json = async () => {
            const body = await originalJSON();
            if (body?.current_revoked === true) {
              let observed = false;
              Object.defineProperty(body, "current_revoked", {
                enumerable: true,
                configurable: true,
                get() {
                  // The consumer validates this field and ends the generation
                  // in one synchronous call stack, with no intervening await.
                  if (!observed) {
                    observed = true;
                    record({ type: "current_revocation_observed" });
                  }
                  return true;
                },
              });
            }
            return body;
          };
        }
        return response;
      };
    },
    { target, storageKey },
  );
}

export async function readRevocationObservation(page) {
  return page.evaluate(
    (key) => JSON.parse(sessionStorage.getItem(key) ?? "[]"),
    storageKey,
  );
}

export function assertRevocationStoppedRequests(events) {
  const observed = events.filter(
    (event) => event.type === "current_revocation_observed",
  );
  assert.equal(
    observed.length,
    1,
    "The client must consume the committed current revocation",
  );
  assert.deepEqual(
    events.filter(
      (event) =>
        event.type === "request" && event.sequence > observed[0].sequence,
    ),
    [],
    "Consumed current revocation cannot send another private request",
  );
}

// Keep the network-side collection alive through context.close(). Only the
// exact activity request proven to precede the held reply may be excluded.
export function assertOnlyPendingActivity(requests, pending) {
  assert.deepEqual(
    requests
      .filter((request) => request !== pending)
      .map((request) => ({
        method: request.method(),
        path: new URL(request.url()).pathname,
      })),
    [],
    "Revocation cannot send private requests beyond the proven pending activity",
  );
}
