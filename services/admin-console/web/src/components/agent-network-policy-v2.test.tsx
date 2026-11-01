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
  lifecycle_state: "created",
  activation_state: "enabled",
  runtime_state: "available",
  aggregate_sequence: 1,
  created_at: "2026-09-10",
  updated_at: "2026-09-10",
};

const scope = JSON.stringify(["org-1", "admin-1"]);

const v2Spec = {
  schema_version: 2,
  default: "deny",
  rules: [
    { action: "allow", domains: ["api.github.com"], ports: [443] },
    {
      action: "allow",
      cidrs: ["10.20.0.15/32"],
      ports: [{ from: 400, to: 450 }],
    },
  ],
};

const legacyPolicy = {
  agent_id: "agent-1",
  action: "deny_all" as const,
  resource_version: 7,
  attachment: { state: "open", resource_version: 4 },
};

function show() {
  return render(<AgentNetworkPolicy agent={agent} scope={scope} />);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("shows a custom v2 policy without silently overwriting it through the legacy toggle", async () => {
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) =>
    Response.json({
      agent_id: "agent-1",
      spec: v2Spec,
      resource_version: 7,
      attachment: { state: "open", resource_version: 4 },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  show();
  await screen.findByText("Custom rules");
  const toggle = screen.getByRole("switch");
  await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Edit custom rules" }));
  await screen.findByLabelText("Rule 1 action");
  expect(screen.getByLabelText("Rule 1 destinations")).toBeTruthy();
  expect(screen.getByLabelText("Rule 2 destinations")).toBeTruthy();
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "PUT")).toEqual(
    [],
  );
});

it("saves edited custom rules as a spec document at the recorded version", async () => {
  const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method !== "PUT") return Response.json(legacyPolicy);
    return Response.json({
      agent_id: "agent-1",
      spec: {
        schema_version: 2,
        default: "deny",
        rules: [{ action: "allow", domains: ["api.github.com"], ports: [443] }],
      },
      resource_version: 8,
    });
  });
  vi.stubGlobal("fetch", fetch);
  show();
  await waitFor(() =>
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit custom rules" }));
  fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
  const destinationType = await screen.findByLabelText(
    "Rule 1 destination type",
  );
  fireEvent.change(destinationType, { target: { value: "domains" } });
  fireEvent.change(screen.getByLabelText("Rule 1 destinations"), {
    target: { value: "api.github.com" },
  });
  fireEvent.change(screen.getByLabelText("Rule 1 ports"), {
    target: { value: "443" },
  });
  fireEvent.change(screen.getByLabelText("Rule 1 action"), {
    target: { value: "allow" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save custom policy" }));
  await screen.findByText("Network policy saved.");
  const commands = fetch.mock.calls.filter(
    ([, init]) => init?.method === "PUT",
  );
  expect(commands).toHaveLength(1);
  const command = commands[0];
  if (!command) throw new Error("missing command");
  const [, init] = command;
  expect(JSON.parse(String(init?.body))).toEqual({
    spec: {
      schema_version: 2,
      default: "deny",
      rules: [{ action: "allow", domains: ["api.github.com"], ports: [443] }],
    },
    expected_resource_version: 7,
  });
  expect(new Headers(init?.headers).get("Idempotency-Key")).toBeTruthy();
  expect(
    new Headers(init?.headers).get("X-Antnest-Expected-Principal"),
  ).toBeTruthy();
});

it("orders, adds and removes draft rules without sending until save", async () => {
  const expected = {
    agent_id: "agent-1",
    spec: {
      schema_version: 2,
      default: "deny",
      rules: [
        { action: "allow", domains: ["first.example.com"], ports: [443] },
      ],
    },
    resource_version: 8,
  };
  const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method !== "PUT") return Response.json(legacyPolicy);
    return Response.json(expected);
  });
  vi.stubGlobal("fetch", fetch);
  show();
  await waitFor(() =>
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit custom rules" }));
  fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
  fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
  await screen.findByLabelText("Rule 1 destinations");
  for (const [rule, domain] of [
    ["Rule 1", "first.example.com"],
    ["Rule 2", "second.example.com"],
  ] as const) {
    fireEvent.change(screen.getByLabelText(`${rule} destination type`), {
      target: { value: "domains" },
    });
    fireEvent.change(screen.getByLabelText(`${rule} destinations`), {
      target: { value: domain },
    });
    fireEvent.change(screen.getByLabelText(`${rule} ports`), {
      target: { value: "443" },
    });
  }
  fireEvent.click(screen.getByRole("button", { name: "Move rule 2 up" }));
  expect(
    (screen.getByLabelText("Rule 1 destinations") as HTMLInputElement).value,
  ).toBe("second.example.com");
  fireEvent.click(screen.getByRole("button", { name: "Remove rule 1" }));
  expect(screen.queryByLabelText("Rule 2 destinations")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save custom policy" }));
  await screen.findByText("Network policy saved.");
  const commands = fetch.mock.calls.filter(
    ([, init]) => init?.method === "PUT",
  );
  expect(commands).toHaveLength(1);
  const command = commands[0];
  if (!command) throw new Error("missing command");
  expect(JSON.parse(String(command[1]?.body))).toEqual({
    spec: expected.spec,
    expected_resource_version: 7,
  });
});

it("blocks a stale draft instead of silently rebasing it", async () => {
  let version = 7;
  const fetch = vi.fn(async (_path: string, init?: RequestInit) =>
    Response.json({ ...legacyPolicy, resource_version: version }),
  );
  vi.stubGlobal("fetch", fetch);
  show();
  await waitFor(() =>
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit custom rules" }));
  await screen.findByRole("button", { name: "Add rule" });
  version = 9;
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh network policy" }),
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Save custom policy" })
        .hasAttribute("disabled"),
    ).toBe(true),
  );
  expect(
    screen
      .getByRole("button", { name: "Edit custom rules" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit custom rules" }));
  await screen.findByRole("button", { name: "Add rule" });
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh network policy" }),
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Save custom policy" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "PUT")).toEqual(
    [],
  );
});

it("retries an uncertain spec write with the identical original intent", async () => {
  const spec = {
    schema_version: 2,
    default: "deny" as const,
    rules: [{ action: "allow", domains: ["api.github.com"], ports: [443] }],
  };
  let writes = 0;
  const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method !== "PUT") return Response.json(legacyPolicy);
    writes++;
    if (writes === 1) throw new TypeError("network unreachable");
    return Response.json({
      agent_id: "agent-1",
      spec,
      resource_version: 8,
    });
  });
  vi.stubGlobal("fetch", fetch);
  show();
  await waitFor(() =>
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit custom rules" }));
  fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
  fireEvent.change(await screen.findByLabelText("Rule 1 destination type"), {
    target: { value: "domains" },
  });
  fireEvent.change(screen.getByLabelText("Rule 1 destinations"), {
    target: { value: "api.github.com" },
  });
  fireEvent.change(screen.getByLabelText("Rule 1 ports"), {
    target: { value: "443" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save custom policy" }));
  expect(
    (screen.getByLabelText("Default action") as HTMLSelectElement).disabled,
  ).toBe(true);
  expect(screen.getByLabelText("Rule 1 ports").matches(":disabled")).toBe(true);
  const retry = await screen.findByRole("button", {
    name: "Retry network update",
  });
  fireEvent.click(retry);
  await screen.findByText("Network policy saved.");
  const commands = fetch.mock.calls.filter(
    ([, init]) => init?.method === "PUT",
  );
  expect(commands).toHaveLength(2);
  const bodies = commands.map(([, init]) => String(init?.body));
  expect(bodies[0]).toBe(bodies[1]);
  expect(new Headers(commands[0]?.[1]?.headers).get("Idempotency-Key")).toBe(
    new Headers(commands[1]?.[1]?.headers).get("Idempotency-Key"),
  );
});

it("keeps an in-flight spec write scoped to the original account", async () => {
  const spec = {
    schema_version: 2,
    default: "deny" as const,
    rules: [{ action: "allow", domains: ["api.github.com"], ports: [443] }],
  };
  const reply = deferred<Response>();
  const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method === "PUT") return reply.promise;
    return Response.json(legacyPolicy);
  });
  vi.stubGlobal("fetch", fetch);
  const page = render(<AgentNetworkPolicy agent={agent} scope={scope} />);
  await waitFor(() =>
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit custom rules" }));
  fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
  fireEvent.change(await screen.findByLabelText("Rule 1 destination type"), {
    target: { value: "domains" },
  });
  fireEvent.change(screen.getByLabelText("Rule 1 destinations"), {
    target: { value: "api.github.com" },
  });
  fireEvent.change(screen.getByLabelText("Rule 1 ports"), {
    target: { value: "443" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save custom policy" }));
  page.rerender(
    <AgentNetworkPolicy
      agent={agent}
      scope={JSON.stringify(["org-2", "admin-1"])}
    />,
  );
  await act(async () =>
    reply.resolve(
      Response.json({ agent_id: "agent-1", spec, resource_version: 8 }),
    ),
  );
  await waitFor(() =>
    expect(screen.queryByText("Network policy saved.")).toBeNull(),
  );
  expect(
    readPendingNetwork(window.localStorage, scope, agent.agent_id),
  ).toBeTruthy();
  const puts = fetch.mock.calls.filter(([, init]) => init?.method === "PUT");
  expect(puts).toHaveLength(1);
});

it("round-trips explicit tcp protocol and equal port ranges through the editor", async () => {
  const spec = {
    schema_version: 2,
    default: "deny" as const,
    rules: [
      {
        action: "allow" as const,
        domains: ["api.github.com"],
        ports: [{ from: 443, to: 443 }],
        protocol: "tcp" as const,
      },
    ],
  };
  const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method !== "PUT")
      return Response.json({
        agent_id: "agent-1",
        spec,
        resource_version: 7,
        attachment: { state: "open", resource_version: 4 },
      });
    return Response.json({
      agent_id: "agent-1",
      spec,
      resource_version: 8,
    });
  });
  vi.stubGlobal("fetch", fetch);
  show();
  await screen.findByText("Custom rules");
  fireEvent.click(screen.getByRole("button", { name: "Edit custom rules" }));
  await screen.findByLabelText("Rule 1 action");
  expect(
    (screen.getByLabelText("Rule 1 destinations") as HTMLInputElement).value,
  ).toBe("api.github.com");
  expect(
    (screen.getByLabelText("Rule 1 ports") as HTMLInputElement).value,
  ).toBe("443-443");
  expect(
    (screen.getByLabelText("Rule 1 protocol") as HTMLInputElement).value,
  ).toBe("tcp");
  fireEvent.click(screen.getByRole("button", { name: "Save custom policy" }));
  await screen.findByText("Network policy saved.");
  const commands = fetch.mock.calls.filter(
    ([, init]) => init?.method === "PUT",
  );
  const command = commands[0];
  if (!command) throw new Error("missing command");
  expect(JSON.parse(String(command[1]?.body))).toEqual({
    spec,
    expected_resource_version: 7,
  });
});
