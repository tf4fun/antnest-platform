import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AgentChooser } from "./AgentChooser";
import { AgentManagementStatus } from "./AgentManagementStatus";
import { Sidebar } from "./Sidebar";
import { PermissionRequests } from "./PermissionRequests";
import type { AgentManagementState, WorkspaceSnapshot } from "../lib/types";

afterEach(cleanup);
const agents: WorkspaceSnapshot["agents"] = [
  "ready",
  "busy",
  "offline",
  "unknown",
].map((status) => ({
  id: status,
  name: `${status} Agent`,
  status: status as "ready" | "busy" | "offline" | "unknown",
  description: "",
  modelLabel: "Model",
  managementState: {
    lifecycle: "created",
    activation: status === "offline" ? "disabled" : "enabled",
    runtime:
      status === "ready"
        ? "available"
        : status === "busy"
          ? "waiting"
          : "unknown",
  },
}));
const principal = {
  userId: "user",
  organizationId: "org",
  displayName: "User",
  organizationName: "Organization",
  administrator: false,
};

test("agent chooser shows management facts, not ACP execution status", () => {
  render(
    <AgentChooser
      workspace={{
        agents,
        principal,
        conversations: [],
        preview: false,
        connection: "ready",
        activeAgentId: "",
        activeConversationId: null,
      }}
      onSelect={vi.fn()}
      onLogout={vi.fn()}
      logoutDisabled={false}
      onRefresh={vi.fn()}
      refreshing={false}
    />,
  );
  for (const label of [
    "Available",
    "Waiting for startup",
    "Disabled",
    "Runtime status unknown",
  ])
    expect(screen.getByText(label)).toBeTruthy();
  expect(screen.queryByText("Working")).toBeNull();
});

test.each<{ state: AgentManagementState; label: string }>([
  {
    state: { lifecycle: "not_created", runtime: "unknown" },
    label: "Not created",
  },
  { state: { lifecycle: "deleted", runtime: "absent" }, label: "Deleted" },
  {
    state: {
      lifecycle: "created",
      activation: "disabled",
      runtime: "available",
    },
    label: "Disabled",
  },
  {
    state: { lifecycle: "created", activation: "enabled", runtime: "waiting" },
    label: "Waiting for startup",
  },
  {
    state: {
      lifecycle: "created",
      activation: "enabled",
      runtime: "available",
    },
    label: "Available",
  },
  {
    state: {
      lifecycle: "created",
      activation: "enabled",
      runtime: "unhealthy",
    },
    label: "Unhealthy",
  },
  {
    state: { lifecycle: "created", activation: "enabled", runtime: "exited" },
    label: "Stopped",
  },
  {
    state: { lifecycle: "created", activation: "enabled", runtime: "absent" },
    label: "Runtime missing",
  },
  {
    state: { lifecycle: "created", activation: "enabled", runtime: "unknown" },
    label: "Runtime status unknown",
  },
])("management condition renders $label", ({ state, label }) => {
  render(<AgentManagementStatus state={state} />);
  expect(screen.getByText(label)).toBeTruthy();
});

test("agent chooser is a standalone directory with search, real navigation links and account actions", () => {
  const onSelect = vi.fn();
  const onLogout = vi.fn();
  const onRefresh = vi.fn();
  render(
    <AgentChooser
      workspace={{
        agents,
        principal: { ...principal, administrator: true },
        conversations: [],
        preview: false,
        connection: "ready",
        activeAgentId: "",
        activeConversationId: null,
      }}
      onSelect={onSelect}
      onLogout={onLogout}
      logoutDisabled={false}
      onRefresh={onRefresh}
      refreshing={false}
    />,
  );
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(screen.queryByRole("button", { name: "Open navigation" })).toBeNull();
  expect(screen.getByText(principal.displayName)).toBeTruthy();
  expect(
    screen
      .getByRole("link", { name: "Open Control Center" })
      .getAttribute("href"),
  ).toBe("/");
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Refresh agents" }));
  expect(onRefresh).toHaveBeenCalledOnce();
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("searchbox", { name: "Find an agent" }), {
    target: { value: "OFFLINE" },
  });
  expect(screen.queryByRole("link", { name: /ready Agent/ })).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("1 of 4 agents");
  const target = screen.getByRole("link", { name: /offline Agent/ });
  expect(target.getAttribute("href")).toBe("/workspace/?agent=offline");
  target.addEventListener("click", (event) => event.preventDefault(), {
    once: true,
  });
  fireEvent.click(target, { ctrlKey: true });
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.click(target);
  expect(onSelect).toHaveBeenCalledWith("offline");
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(screen.getByRole("link", { name: /ready Agent/ })).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "absent" },
  });
  expect(
    screen.getByRole("heading", { name: "No matching agents" }),
  ).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
  expect(screen.getByRole("status").textContent).toBe("4 agents");
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(onLogout).toHaveBeenCalledOnce();
});

test("chooser keeps account permissions and in-flight actions honest", () => {
  const onRefresh = vi.fn();
  const onLogout = vi.fn();
  render(
    <AgentChooser
      workspace={{
        agents,
        principal,
        conversations: [],
        preview: false,
        connection: "ready",
        activeAgentId: "",
        activeConversationId: null,
      }}
      error="Refresh failed"
      onSelect={vi.fn()}
      onLogout={onLogout}
      logoutDisabled
      onRefresh={onRefresh}
      refreshing
    />,
  );
  expect(
    screen.queryByRole("link", { name: "Open Control Center" }),
  ).toBeNull();
  expect(screen.getByRole("alert").textContent).toBe("Refresh failed");
  fireEvent.click(screen.getByRole("button", { name: "Refresh agents" }));
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(onRefresh).not.toHaveBeenCalled();
  expect(onLogout).not.toHaveBeenCalled();
});

test("sidebar shows ACP status only for the selected Agent", () => {
  render(
    <Sidebar
      catalog={{ loading: false, hasMore: false, loadMore: vi.fn() }}
      catalogDisabled={false}
      agents={agents}
      principal={principal}
      conversations={[]}
      activeAgentId="ready"
      activeConversationId={null}
      open={false}
      agentSwitchDisabled={false}
      newConversationDisabled={false}
      logoutDisabled={false}
      onClose={vi.fn()}
      onSelectAgent={vi.fn()}
      onSelectConversation={vi.fn()}
      onNewConversation={vi.fn()}
      onLogout={vi.fn()}
      onChooseAgent={vi.fn()}
    />,
  );
  const selected = screen.getByRole("button", { name: /ready Agent/ });
  expect(selected.getAttribute("aria-current")).toBe("true");
  expect(within(selected).getByText("Available")).toBeTruthy();
  expect(
    within(screen.getByRole("button", { name: /offline Agent/ })).getByText(
      "Disabled",
    ),
  ).toBeTruthy();
});

test("approval choices preserve names and expose distinct allow and reject treatments", () => {
  const onAnswer = vi.fn();
  render(
    <PermissionRequests
      conversations={[]}
      onOpen={vi.fn()}
      onAnswer={onAnswer}
      requests={[
        {
          id: "request",
          request: {
            sessionId: "session",
            toolCall: {
              toolCallId: "tool",
              title: "Run report",
              rawInput: { command: "report" },
            },
            options: [
              { optionId: "yes", kind: "allow_once", name: "Allow once" },
              { optionId: "no", kind: "reject_once", name: "Reject" },
            ],
          },
        },
      ]}
    />,
  );
  expect(
    screen
      .getByRole("button", { name: "Allow once" })
      .getAttribute("data-decision"),
  ).toBe("allow");
  expect(
    screen
      .getByRole("button", { name: "Reject", exact: true })
      .getAttribute("data-decision"),
  ).toBe("reject");
  expect(
    screen.getByRole("region", { name: "Requested tool input" }).tabIndex,
  ).toBe(0);
  screen.getByRole("button", { name: "Reject", exact: true }).click();
  expect(onAnswer).toHaveBeenCalledWith("request", "no");
});
