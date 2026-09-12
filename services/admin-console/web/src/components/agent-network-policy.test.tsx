import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentNetworkPolicy } from "./agent-network-policy";
import { readPendingNetwork, savePendingNetwork } from "../lib/network-policy";
import type { Agent } from "../lib/types";

declare const jsdom: { window: Window };
beforeEach(() => {
  vi.stubGlobal("localStorage", jsdom.window.localStorage);
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  window.localStorage.clear();
});
const agent: Agent = {
  agent_id: "agent-1",
  name: "Support Agent",
  owner_user_id: "owner-1",
  desired_state: "enabled",
  lifecycle_state: "available",
  aggregate_sequence: 1,
  created_at: "2026-09-10",
  updated_at: "2026-09-10",
};
const policy = {
  agent_id: "agent-1",
  action: "deny_all",
  resource_version: 7,
  attachment: { state: "open", resource_version: 4 },
};
const scope = JSON.stringify(["org-1", "admin-1"]);

it("keeps a second pending request retryable after the first conflicts and refresh succeeds", async () => {
  const first = {
    action: "allow_all" as const,
    expected_resource_version: 7,
    idempotency_key: "a-network-pending-request",
  };
  const second = { ...first, idempotency_key: "b-network-pending-request" };
  for (const item of [first, second])
    savePendingNetwork(window.localStorage, scope, agent.agent_id, item);
  let writes = 0;
  const fetch = vi.fn(async (_path: string, init: RequestInit) => {
    if (init.method !== "PUT") return Response.json(policy);
    writes++;
    return writes === 1
      ? Response.json(
          {
            code: "resource_version_conflict",
            message: "Conflict requires a fresh read",
          },
          { status: 409 },
        )
      : Response.json({
          agent_id: "agent-1",
          action: "allow_all",
          resource_version: 8,
        });
  });
  vi.stubGlobal("fetch", fetch);
  show();
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Retry network update" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry network update" }));
  await screen.findByText("Conflict requires a fresh read");
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh network policy" }),
  );
  await waitFor(() =>
    expect(screen.queryByText("Conflict requires a fresh read")).toBeNull(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry network update" }));
  await screen.findByText("Network policy saved.");
  const commands = fetch.mock.calls.filter(([, init]) => init.method === "PUT");
  expect(
    commands.map(([, init]) =>
      new Headers(init.headers).get("Idempotency-Key"),
    ),
  ).toEqual([first.idempotency_key, second.idempotency_key]);
  expect(
    readPendingNetwork(window.localStorage, scope, agent.agent_id),
  ).toBeUndefined();
});
function show(value = agent) {
  return render(<AgentNetworkPolicy agent={value} scope={scope} />);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["deleting", "deleted"] as const)(
  "hides network controls for %s Agents without requesting policy",
  async (state) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    show({ ...agent, lifecycle_state: state });
    expect(screen.queryByRole("switch")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("cancels old reads and ignores a late snapshot after switching Agent", async () => {
  const reply = deferred<Response>();
  const fetch = vi.fn(async (path: string) =>
    path.includes("agent-1")
      ? reply.promise
      : Response.json({ ...policy, agent_id: "agent-2" }),
  );
  vi.stubGlobal("fetch", fetch);
  const page = show();
  page.rerender(
    <AgentNetworkPolicy
      agent={{ ...agent, agent_id: "agent-2" }}
      scope={scope}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(false),
  );
  await act(async () =>
    reply.resolve(Response.json({ ...policy, action: "allow_all" })),
  );
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
});

it("shows confirmed policy and saves one CAS without optimistic success", async () => {
  const reply = deferred<Response>();
  const fetch = vi.fn(async (_path: string, init: RequestInit) =>
    init.method === "PUT" ? reply.promise : Response.json(policy),
  );
  vi.stubGlobal("fetch", fetch);
  show();
  const toggle = await screen.findByRole("switch", {
    name: "Public internet access",
  });
  await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  fireEvent.click(toggle);
  expect(screen.getByText("Saving network policy...")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(
    fetch.mock.calls.filter(([, init]) => init.method === "PUT"),
  ).toHaveLength(1);
  const saved = readPendingNetwork(window.localStorage, scope, agent.agent_id)!;
  expect(saved.expected_resource_version).toBe(7);
  expect(
    new Headers(fetch.mock.calls[1]![1].headers).get(
      "X-Antnest-Expected-Principal",
    ),
  ).toBe(encodeURIComponent(scope));
  await act(async () =>
    reply.resolve(
      Response.json({
        agent_id: "agent-1",
        action: "allow_all",
        resource_version: 8,
      }),
    ),
  );
  expect(await screen.findByText("Network policy saved.")).toBeTruthy();
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(
    readPendingNetwork(window.localStorage, scope, agent.agent_id),
  ).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("retains response-loss intent through refresh/remount and retries exactly", async () => {
  let writes = 0;
  const fetch = vi.fn(async (_path: string, init: RequestInit) => {
    if (init.method === "PUT") {
      writes++;
      if (writes === 1) throw new TypeError("connection lost");
      return Response.json({
        agent_id: "agent-1",
        action: "allow_all",
        resource_version: 8,
      });
    }
    return Response.json(
      writes ? { ...policy, action: "allow_all", resource_version: 8 } : policy,
    );
  });
  vi.stubGlobal("fetch", fetch);
  const first = show();
  await waitFor(() =>
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(false),
  );
  fireEvent.click(screen.getByRole("switch"));
  expect(
    await screen.findByRole("button", { name: "Retry network update" }),
  ).toBeTruthy();
  first.unmount();
  sessionStorage.clear();
  show();
  await screen.findByRole("button", { name: "Retry network update" });
  await waitFor(() =>
    expect(
      fetch.mock.calls.filter(([, init]) => init.method === "GET"),
    ).toHaveLength(2),
  );
  expect(screen.queryByText("Network policy saved.")).toBeNull();
  expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh network policy" }),
  );
  await waitFor(() =>
    expect(
      fetch.mock.calls.filter(([, init]) => init.method === "GET"),
    ).toHaveLength(3),
  );
  expect(
    screen.getByRole("button", { name: "Retry network update" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry network update" }));
  await screen.findByText("Network policy saved.");
  const commands = fetch.mock.calls.filter(([, init]) => init.method === "PUT");
  expect(commands[0]![1].body).toBe(commands[1]![1].body);
  expect(new Headers(commands[0]![1].headers).get("Idempotency-Key")).toBe(
    new Headers(commands[1]![1].headers).get("Idempotency-Key"),
  );
});

it("conflict requires a read and a new deliberate selection, never auto rebase", async () => {
  let writes = 0;
  const fetch = vi.fn(async (_path: string, init: RequestInit) => {
    if (init.method === "PUT") {
      writes++;
      return Response.json(
        {
          code: "resource_version_conflict",
          message: "Changed by another administrator.",
        },
        { status: 409 },
      );
    }
    return Response.json({ ...policy, resource_version: writes ? 9 : 7 });
  });
  vi.stubGlobal("fetch", fetch);
  show();
  await waitFor(() =>
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(false),
  );
  fireEvent.click(screen.getByRole("switch"));
  await screen.findByText(/Changed by another administrator/);
  expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(true);
  expect(writes).toBe(1);
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh network policy" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(false),
  );
  expect(writes).toBe(1);
  fireEvent.click(screen.getByRole("switch"));
  await waitFor(() => expect(writes).toBe(2));
  const bodies = fetch.mock.calls
    .filter(([, init]) => init.method === "PUT")
    .map(([, init]) => JSON.parse(String(init.body)));
  expect(bodies.map((body) => body.expected_resource_version)).toEqual([7, 9]);
});

it("disabled Agents can save policy without claiming traffic resumed", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_path: string, init: RequestInit) =>
      Response.json(
        init.method === "PUT"
          ? { agent_id: "agent-1", action: "allow_all", resource_version: 8 }
          : { ...policy, attachment: { state: "closed", resource_version: 4 } },
      ),
    ),
  );
  show({ ...agent, lifecycle_state: "disabled", desired_state: "disabled" });
  await waitFor(() =>
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(false),
  );
  fireEvent.click(screen.getByRole("switch"));
  await screen.findByText("Network policy saved.");
  expect(screen.getByText("Agent network is paused.")).toBeTruthy();
});

it("storage failure and missing account scope prevent mutations", async () => {
  const fetch = vi.fn(async () => Response.json(policy));
  vi.stubGlobal("fetch", fetch);
  const first = render(<AgentNetworkPolicy agent={agent} />);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(true);
  first.unmount();
  show();
  await waitFor(() =>
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(false),
  );
  vi.spyOn(
    Object.getPrototypeOf(window.localStorage),
    "setItem",
  ).mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  fireEvent.click(screen.getByRole("switch"));
  await screen.findByText(/Storage unavailable/);
  expect(fetch.mock.calls).toHaveLength(2);
});

it("preserves an old account's uncertain request when cookies change under the mounted page", async () => {
  const fetch = vi.fn(async (_path: string, init: RequestInit) =>
    init.method === "PUT"
      ? Response.json(
          {
            code: "principal_changed",
            message: "Account changed. Reload this page.",
          },
          { status: 409 },
        )
      : Response.json(policy),
  );
  vi.stubGlobal("fetch", fetch);
  show();
  await waitFor(() =>
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(false),
  );
  fireEvent.click(screen.getByRole("switch"));
  await screen.findByText(/Account changed/);
  expect(
    readPendingNetwork(window.localStorage, scope, agent.agent_id),
  ).toBeDefined();
  expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(true);
  expect(
    screen.queryByRole("button", { name: "Retry network update" }),
  ).toBeNull();
});

it("coalesces lifecycle invalidations during writes into a separate read", async () => {
  const reply = deferred<Response>();
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_path: string, init: RequestInit) => {
      if (init.method === "PUT") return reply.promise;
      reads++;
      return Response.json({
        ...policy,
        attachment: {
          state: reads === 1 ? "closed" : "open",
          resource_version: reads + 3,
        },
      });
    }),
  );
  const page = show({
    ...agent,
    lifecycle_state: "disabled",
    desired_state: "disabled",
  });
  await waitFor(() =>
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(false),
  );
  fireEvent.click(screen.getByRole("switch"));
  page.rerender(<AgentNetworkPolicy agent={agent} scope={scope} />);
  expect(reads).toBe(1);
  await act(async () =>
    reply.resolve(
      Response.json({
        agent_id: "agent-1",
        action: "allow_all",
        resource_version: 8,
      }),
    ),
  );
  await waitFor(() => expect(reads).toBe(2));
  await waitFor(() =>
    expect(screen.queryByText("Agent network is paused.")).toBeNull(),
  );
});

it("late writes after switching Agent do not alter the new page or erase recovery intent", async () => {
  const reply = deferred<Response>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit) =>
      init.method === "PUT"
        ? reply.promise
        : Response.json({
            ...policy,
            agent_id: path.includes("agent-2") ? "agent-2" : "agent-1",
          }),
    ),
  );
  const page = show();
  await waitFor(() =>
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(false),
  );
  fireEvent.click(screen.getByRole("switch"));
  page.rerender(
    <AgentNetworkPolicy
      agent={{ ...agent, agent_id: "agent-2" }}
      scope={scope}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(false),
  );
  await act(async () =>
    reply.resolve(
      Response.json({
        agent_id: "agent-1",
        action: "allow_all",
        resource_version: 8,
      }),
    ),
  );
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  expect(screen.queryByText("Network policy saved.")).toBeNull();
  expect(
    readPendingNetwork(window.localStorage, scope, "agent-1"),
  ).toBeDefined();
});

it("malformed successful writes remain uncertain and another scope cannot replay", async () => {
  const fetch = vi.fn(async (_path: string, init: RequestInit) =>
    Response.json(init.method === "PUT" ? {} : policy),
  );
  vi.stubGlobal("fetch", fetch);
  const first = show();
  await waitFor(() =>
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(false),
  );
  fireEvent.click(screen.getByRole("switch"));
  await screen.findByRole("button", { name: "Retry network update" });
  first.unmount();
  render(<AgentNetworkPolicy agent={agent} scope="org-2:admin-1" />);
  await waitFor(() =>
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(false),
  );
  expect(
    screen.queryByRole("button", { name: "Retry network update" }),
  ).toBeNull();
});
