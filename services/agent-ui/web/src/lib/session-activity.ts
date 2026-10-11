import type { SessionMetadata } from "./browser-session.ts";

const activityEvents = ["input", "keydown", "pointerdown", "pointermove", "wheel", "touchstart", "touchmove"] as const;

export function createActivityReporter(
  initialInterval: number,
  report: (signal: AbortSignal) => Promise<SessionMetadata>,
  received: (metadata: SessionMetadata) => void = () => undefined,
) {
  let interval = initialInterval;
  let due = 0;
  let dirty = false;
  let stopped = false;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  let active: { controller: AbortController; timeout: ReturnType<typeof setTimeout>; start: number } | undefined;

  function schedule() {
    if (stopped || !dirty || active) return;
    if (trailing !== undefined) clearTimeout(trailing);
    if (performance.now() >= due) dispatch();
    else trailing = setTimeout(() => { trailing = undefined; schedule(); }, due - performance.now());
  }

  function dispatch() {
    if (stopped || active) return;
    dirty = false;
    const start = performance.now();
    due = start + interval;
    const controller = new AbortController();
    const operation = {
      controller, start,
      timeout: setTimeout(() => {
        controller.abort();
        finish();
      }, interval),
    };
    active = operation;

    function finish() {
      if (active !== operation) return;
      clearTimeout(operation.timeout);
      active = undefined;
      schedule();
    }

    void report(controller.signal).then(metadata => {
      if (stopped || active !== operation || controller.signal.aborted) return;
      if (Number.isInteger(metadata.activity_interval_ms) && metadata.activity_interval_ms >= 1 && metadata.activity_interval_ms <= 30000) {
        interval = metadata.activity_interval_ms;
        due = start + interval;
        received(metadata);
      }
    }).catch(() => {
      // The request boundary handles current-session 401s. Transient errors
      // preserve the session; only fresh or already-dirty input may report again.
    }).finally(finish);
  }

  return {
    observe(event: Pick<Event, "type" | "isTrusted">) {
      if (stopped || !event.isTrusted || !activityEvents.some(type => type === event.type)) return;
      dirty = true;
      schedule();
    },
    dispose() {
      stopped = true;
      if (trailing !== undefined) clearTimeout(trailing);
      if (active) {
        clearTimeout(active.timeout);
        active.controller.abort();
        active = undefined;
      }
    },
  };
}

export function listenForSessionActivity(interval: number, report: (signal: AbortSignal) => Promise<SessionMetadata>): () => void {
  const reporter = createActivityReporter(interval, report);
  const observe = (event: Event) => {
    if (document.visibilityState !== "hidden") reporter.observe(event);
  };
  for (const type of activityEvents) document.addEventListener(type, observe, { capture: true, passive: true });
  return () => {
    for (const type of activityEvents) document.removeEventListener(type, observe, true);
    reporter.dispose();
  };
}
