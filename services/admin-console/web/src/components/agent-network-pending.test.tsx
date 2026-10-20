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
import { readPendingNetwork } from "../lib/network-policy";
import type { Agent } from "../lib/types";

declare const jsdom: { window: Window };
beforeEach(() => vi.stubGlobal("localStorage", jsdom.window.localStorage));
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
const agent: Agent = {
  agent_id: "agent-1",
  name: "Pending Agent",
  owner_user_id: "owner-1",
  desired_state: "enabled",
  lifecycle_state: "created",
  activation_state: "enabled",
  runtime_state: "waiting",
  aggregate_sequence: 1,
  runtime: { runtime_revision: "runtime-1" },
  created_at: "2026-09-10",
  updated_at: "2026-09-10",
};
const scope = JSON.stringify(["org-1", "admin-1"]);
const pending = {
  agent_id: agent.agent_id,
  action: "deny_all",
  resource_version: 7,
  attachment: { state: "pending", resource_version: 2 },
};
const waiting = "Waiting for the Runtime to connect. Agent network is paused.";

it("saves a desired policy while preserving the pending attachment", async () => {
  const fetch = vi.fn(async (_path: string, init: RequestInit) =>
    Response.json(
      init.method === "PUT"
        ? { agent_id: agent.agent_id, action: "allow_all", resource_version: 8 }
        : pending,
    ),
  );
  vi.stubGlobal("fetch", fetch);
  render(<AgentNetworkPolicy agent={agent} scope={scope} />);
  await screen.findByText(waiting);
  fireEvent.click(screen.getByRole("switch"));
  await screen.findByText("Network policy saved.");
  expect(screen.getByText(waiting)).toBeTruthy();
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetch.mock.calls[1]![1].body as string)).toEqual({
    action: "allow_all",
    expected_resource_version: 7,
  });
});

it.each(["condition", "execution"])(
  "rereads a pending attachment after a %s change without inferring open",
  async (change) => {
    let snapshot = pending;
    const fetch = vi.fn(async () => Response.json(snapshot));
    vi.stubGlobal("fetch", fetch);
    const initial = {
      ...agent,
      runtime_state: change === "execution" ? "available" : "waiting",
    };
    const page = render(<AgentNetworkPolicy agent={initial} scope={scope} />);
    await screen.findByText(waiting);
    const next = {
      ...initial,
      runtime_state: "available",
      ...(change === "execution"
        ? { executable_execution_revision: "execution-1" }
        : {}),
    };
    page.rerender(<AgentNetworkPolicy agent={next} scope={scope} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await screen.findByText(waiting);
    snapshot = {
      ...pending,
      attachment: { state: "open", resource_version: 3 },
    };
    // A starting peer can bind without another Agent event; only an actual read
    // may replace the last confirmed pending snapshot.
    await act(async () =>
      page.rerender(<AgentNetworkPolicy agent={{ ...next }} scope={scope} />),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByText(waiting)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh network policy" }),
    );
    await waitFor(() => expect(screen.queryByText(waiting)).toBeNull());
    expect(fetch).toHaveBeenCalledTimes(3);
  },
);

it("retains an uncertain policy write when a later execution event refreshes pending to open", async () => {
  let snapshot = pending;
  const fetch = vi.fn(async (_path: string, init: RequestInit) => {
    if (init.method === "PUT") throw new TypeError("response lost");
    return Response.json(snapshot);
  });
  vi.stubGlobal("fetch", fetch);
  const initial = { ...agent, runtime_state: "available" };
  const page = render(<AgentNetworkPolicy agent={initial} scope={scope} />);
  await screen.findByText(waiting);
  fireEvent.click(screen.getByRole("switch"));
  await screen.findByRole("button", { name: "Retry network update" });
  const intent = readPendingNetwork(window.localStorage, scope, agent.agent_id);
  expect(intent).toMatchObject({
    action: "allow_all",
    expected_resource_version: 7,
  });
  snapshot = {
    ...pending,
    action: "allow_all",
    resource_version: 8,
    attachment: { state: "open", resource_version: 3 },
  };
  page.rerender(
    <AgentNetworkPolicy
      agent={{ ...initial, executable_execution_revision: "execution-1" }}
      scope={scope}
    />,
  );
  await waitFor(() => expect(screen.queryByText(waiting)).toBeNull());
  expect(
    readPendingNetwork(window.localStorage, scope, agent.agent_id),
  ).toEqual(intent);
  expect(
    screen.getByRole("button", { name: "Retry network update" }),
  ).toBeTruthy();
  expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(true);
  expect(screen.queryByText("Network policy saved.")).toBeNull();
  expect(
    fetch.mock.calls.filter(([, init]) => init.method === "PUT"),
  ).toHaveLength(1);
});
