import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ExecutionAuditsPage } from "./execution-audits";

const summary = {
  run_id: "run/one #2",
  session_id: "session-1",
  agent_id: "deleted-agent",
  principal_id: "owner-1",
  state: "completed",
  created_at: "2026-09-14T10:00:00.123456Z",
  updated_at: "2026-09-14T10:01:00Z",
};
const detail = {
  ...summary,
  input: [{ type: "text", text: "original prompt <script>" }],
  execution_snapshot: { executionSpec: { model: { model: "example-model" } } },
  terminal_class: "completed",
  executor_state: "quiescent",
  tool_effect_state: "settled",
  stop_reason: "end_turn",
  error_class: null,
  usage_measurements: [{ input_tokens: 12 }],
};

afterEach(() => {
  cleanup();
});

function stubAuditFetch(reply: (url: URL) => Response | Promise<Response>) {
  const fetch = vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input, "http://localhost");
    expect(init.method).toBe("GET");
    expect(url.pathname.startsWith("/api/admin/execution-audits")).toBe(true);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return reply(url);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it("reads retained Agent history directly, with opaque pagination and original date filters", async () => {
  const fetch = stubAuditFetch((url) =>
    Response.json({
      items: url.searchParams.has("cursor")
        ? [{ ...summary, run_id: "run-two" }]
        : [summary],
      next_cursor: url.searchParams.has("cursor") ? null : "cursor:/+opaque==",
    }),
  );
  render(<ExecutionAuditsPage agentID="deleted-agent" />);
  expect(
    (await screen.findByRole("link", { name: summary.run_id })).getAttribute(
      "href",
    ),
  ).toBe("#audits/run%2Fone%20%232");
  expect(
    new URL(fetch.mock.calls[0]![0], "http://localhost").searchParams.get(
      "agent_id",
    ),
  ).toBe("deleted-agent");
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await screen.findByRole("link", { name: "run-two" });
  expect(
    new URL(fetch.mock.calls[1]![0], "http://localhost").searchParams.get(
      "cursor",
    ),
  ).toBe("cursor:/+opaque==");
  fireEvent.change(screen.getByLabelText("Session ID"), {
    target: { value: "Session /+2" },
  });
  fireEvent.change(screen.getByLabelText("Created from (UTC)"), {
    target: { value: "2026-09-14T10:00:00.123456Z" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
  await screen.findByRole("link", { name: summary.run_id });
  const last = new URL(fetch.mock.calls.at(-1)![0], "http://localhost");
  expect(last.searchParams.get("session_id")).toBe("Session /+2");
  expect(last.searchParams.get("created_from")).toBe(
    "2026-09-14T10:00:00.123456Z",
  );
  expect(last.searchParams.has("cursor")).toBe(false);
});

it("keeps detail, tool content and permissions separate when one stream fails", async () => {
  let fail = true;
  const fetch = stubAuditFetch((url) => {
    if (!url.pathname.endsWith("/events")) return Response.json(detail);
    if (url.searchParams.get("stream") === "permissions")
      return fail
        ? Response.json(
            {
              code: "execution_audit_unavailable",
              message: "Permission history unavailable",
              retryable: true,
            },
            { status: 503 },
          )
        : Response.json({
            stream: "permissions",
            items: [
              {
                tool_call_id: "tool-1",
                request: { command: "pwd" },
                decision: "allow_once",
                reason: null,
                decided_at: null,
                created_at: summary.created_at,
              },
            ],
            next_cursor: null,
          });
    return Response.json({
      stream: "execution",
      items: [
        {
          id: "event-1",
          sequence: 4,
          kind: "tool_result",
          visible: false,
          payload: { command: "pwd", output: "/workspace" },
          created_at: summary.created_at,
        },
      ],
      next_cursor: null,
    });
  });
  const page = render(<ExecutionAuditsPage runID={summary.run_id} />);
  await screen.findByText(/original prompt <script>/);
  await screen.findByText(/example-model/);
  await screen.findByText(/input_tokens/);
  await screen.findByText("tool_result");
  expect(page.container.querySelector("script")).toBeNull();
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Permission history unavailable",
  );
  expect(screen.queryByText("No permission records")).toBeNull();
  expect(
    screen.getByRole("heading", { name: "Execution events" }),
  ).toBeTruthy();
  fail = false;
  fireEvent.click(
    screen.getByRole("button", { name: "Retry permission records" }),
  );
  await screen.findByText("allow_once");
  expect(
    fetch.mock.calls.filter(([path]) => !path.includes("/events")),
  ).toHaveLength(1);
  expect(
    fetch.mock.calls.filter(([path]) => path.includes("stream=execution")),
  ).toHaveLength(1);
  expect(page.container.querySelectorAll("details[open]")).toHaveLength(0);
});

it("keeps loaded pages on failure and retries exactly the failed cursor", async () => {
  let fail = true;
  const fetch = stubAuditFetch((url) => {
    if (url.searchParams.has("cursor") && fail)
      return Response.json({ message: "Page unavailable" }, { status: 503 });
    return Response.json({
      items: url.searchParams.has("cursor") ? [] : [summary],
      next_cursor: url.searchParams.has("cursor") ? null : "next-one",
    });
  });
  render(<ExecutionAuditsPage />);
  await screen.findByRole("link", { name: summary.run_id });
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await screen.findByText("Page unavailable");
  expect(screen.getByRole("link", { name: summary.run_id })).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("link", { name: summary.run_id });
  expect(fetch.mock.calls.at(-1)![0]).toBe(fetch.mock.calls.at(-2)![0]);
});

it("keeps execution and permission cursors independent", async () => {
  const fetch = stubAuditFetch((url) => {
    if (!url.pathname.endsWith("/events")) return Response.json(detail);
    const stream = url.searchParams.get("stream");
    return Response.json({
      stream,
      items: [],
      next_cursor: url.searchParams.has("cursor") ? null : `${stream}-next`,
    });
  });
  render(<ExecutionAuditsPage runID={summary.run_id} />);
  const events = await screen.findByRole("region", {
    name: "Execution events",
  });
  const permissions = await screen.findByRole("region", {
    name: "Permission records",
  });
  fireEvent.click(
    await within(events).findByRole("button", { name: "Load more" }),
  );
  fireEvent.click(
    await within(permissions).findByRole("button", { name: "Load more" }),
  );
  await act(async () => {});
  const cursors = fetch.mock.calls
    .map(([path]) =>
      new URL(path, "http://localhost").searchParams.get("cursor"),
    )
    .filter(Boolean);
  expect(cursors).toEqual(["execution-next", "permissions-next"]);
});

it("cancels old reads and ignores late data when the Agent filter changes", async () => {
  let resolve!: (value: Response) => void;
  const old = new Promise<Response>((done) => {
    resolve = done;
  });
  const fetch = stubAuditFetch((url) =>
    url.searchParams.get("agent_id") === "old"
      ? old
      : Response.json({ items: [], next_cursor: null }),
  );
  const page = render(<ExecutionAuditsPage agentID="old" />);
  const oldSignal = fetch.mock.calls[0]![1].signal!;
  page.rerender(<ExecutionAuditsPage agentID="new" />);
  await screen.findByText("No executions");
  expect(oldSignal.aborted).toBe(true);
  await act(async () =>
    resolve(Response.json({ items: [summary], next_cursor: null })),
  );
  expect(screen.queryByRole("link", { name: summary.run_id })).toBeNull();
  page.unmount();
  expect(fetch.mock.calls.at(-1)![1].signal!.aborted).toBe(true);
});

it.each([403, 404, 503])(
  "does not turn a %s detail failure into empty history",
  async (status) => {
    stubAuditFetch((url) =>
      url.pathname.endsWith("/events")
        ? Response.json({
            stream: url.searchParams.get("stream"),
            items: [],
            next_cursor: null,
          })
        : Response.json(
            { message: "Execution detail unavailable" },
            { status },
          ),
    );
    render(<ExecutionAuditsPage runID="run-1" />);
    await screen.findByText("Execution detail unavailable");
    expect(screen.queryByText("No executions")).toBeNull();
  },
);

it("refreshes detail without unloading paginated streams, even when the detail read fails", async () => {
  let fail = false;
  const fetch = stubAuditFetch((url) => {
    if (!url.pathname.endsWith("/events"))
      return fail
        ? Response.json({ message: "Detail refresh failed" }, { status: 503 })
        : Response.json(detail);
    const stream = url.searchParams.get("stream");
    const next = url.searchParams.has("cursor");
    return Response.json({
      stream,
      next_cursor: next ? null : `${stream}-next`,
      items:
        stream === "execution"
          ? [
              {
                id: `event-${next}`,
                sequence: next ? 2 : 1,
                kind: next ? "tool_result" : "tool_start",
                visible: true,
                payload: {},
                created_at: summary.created_at,
              },
            ]
          : [
              {
                tool_call_id: `tool-${next}`,
                request: {},
                decision: next ? "allow_always" : "allow_once",
                reason: null,
                created_at: summary.created_at,
                decided_at: null,
              },
            ],
    });
  });
  render(<ExecutionAuditsPage runID={summary.run_id} />);
  await screen.findByText("tool_start");
  const events = screen.getByRole("region", { name: "Execution events" });
  const permissions = screen.getByRole("region", {
    name: "Permission records",
  });
  fireEvent.click(within(events).getByRole("button", { name: "Load more" }));
  fireEvent.click(
    within(permissions).getByRole("button", { name: "Load more" }),
  );
  await screen.findByText("tool_result");
  await screen.findByText("allow_always");
  const streamCount = fetch.mock.calls.filter(([path]) =>
    path.includes("/events"),
  ).length;
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh execution detail" }),
  );
  await screen.findByText(/original prompt/);
  expect(screen.getByText("tool_result")).toBeTruthy();
  expect(screen.getByText("allow_always")).toBeTruthy();
  fail = true;
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh execution detail" }),
  );
  await screen.findByText("Detail refresh failed");
  expect(screen.getByText("tool_result")).toBeTruthy();
  expect(screen.getByText("allow_always")).toBeTruthy();
  expect(
    fetch.mock.calls.filter(([path]) => path.includes("/events")),
  ).toHaveLength(streamCount);
});
