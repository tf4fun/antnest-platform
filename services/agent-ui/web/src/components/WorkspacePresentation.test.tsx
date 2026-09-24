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

test("a disconnected permission inbox remains readable without actionable decisions", () => {
  const onAnswer = vi.fn();
  render(<PermissionRequests conversations={[]} onOpen={vi.fn()} onAnswer={onAnswer}
    disabled requests={[{ id: "request", request: { sessionId: "session",
      toolCall: { toolCallId: "tool", title: "Run report", rawInput: { command: "report" } },
      options: [{ optionId: "yes", kind: "allow_once", name: "Allow once" }],
    } }]} />);
  expect(screen.getByText("Run report")).toBeTruthy();
  const button = screen.getByRole("button", { name: "Allow once" });
  expect(button.hasAttribute("disabled")).toBe(true);
  fireEvent.click(button);
  expect(onAnswer).not.toHaveBeenCalled();
});

test("same-named tool decisions expose their Session and tool as accessible descriptions", () => {
  render(<PermissionRequests
    conversations={[{ id: "session-a", title: "Budget review" },
      { id: "session-b", title: "Incident review" }]}
    onOpen={vi.fn()} onAnswer={vi.fn()}
    requests={["session-a", "session-b"].map((sessionId) => ({
      id: sessionId,
      request: {
        sessionId,
        toolCall: { toolCallId: `tool-${sessionId}`, title: "Read report", rawInput: {} },
        options: [{ optionId: "allow", kind: "allow_once" as const, name: "Allow once" }],
      },
    }))}
  />);
  expect(screen.getByRole("button", {
    name: "Allow once", description: /Conversation: Budget review.*Read report/,
  })).toBeTruthy();
  expect(screen.getByRole("button", {
    name: "Allow once", description: /Conversation: Incident review.*Read report/,
  })).toBeTruthy();
  expect(screen.getByRole("region", {
    name: "Tool approval", description: /Conversation: Budget review.*Read report/,
  })).toBeTruthy();
  expect(screen.getByRole("region", {
    name: "Requested tool input", description: /Conversation: Incident review.*Read report/,
  })).toBeTruthy();
});

test("permission live announcement stays concise when tool input is large", () => {
  const request = {
    id: "request-a",
    request: {
      sessionId: "session-a",
      toolCall: { toolCallId: "tool-a", title: "Read report",
        rawInput: { text: "long-input".repeat(2_000) } },
      options: [{ optionId: "allow", kind: "allow_once" as const, name: "Allow once" }],
    },
  };
  const props = { conversations: [{ id: "session-a", title: "Budget review" },
    { id: "session-b", title: "Incident review" }], onOpen: vi.fn(), onAnswer: vi.fn() };
  const view = render(<PermissionRequests {...props} requests={[]} />);
  const liveStatus = screen.getByRole("status");
  expect(liveStatus.textContent).toBe("");
  view.rerender(<PermissionRequests {...props} requests={[request]} />);
  expect(screen.getByRole("status")).toBe(liveStatus);
  expect(screen.getByRole("status").textContent).toBe(
    "1 tool approval requires a decision. Most recent: Read report in Budget review.",
  );
  expect(screen.getByRole("region", { name: "Requested tool input" }).textContent)
    .toContain("long-input");
  view.rerender(<PermissionRequests {...props} requests={[request,
    { ...request, id: "request-b", request: { ...request.request,
      sessionId: "session-b", toolCall: { ...request.request.toolCall,
        title: "Inspect log" } } }]} />);
  expect(screen.getByRole("status").textContent).toBe(
    "2 tool approvals require a decision. Most recent: Inspect log in Incident review.",
  );
  expect(screen.getByRole("status").textContent?.length).toBeLessThan(200);
  view.rerender(<PermissionRequests {...props}
    conversations={[{ id: "session-a", title: "Long session ".repeat(200) }]}
    requests={[{ ...request, request: { ...request.request,
      toolCall: { ...request.request.toolCall, title: "Long tool ".repeat(200) },
    } }]} />);
  expect(screen.getByRole("status").textContent?.length).toBeLessThan(200);
});

test("resolving focused tool approvals moves through the next request to messages", () => {
  const request = {
    id: "request",
    request: {
      sessionId: "session",
      toolCall: { toolCallId: "tool", title: "Run report", rawInput: {} },
      options: [{ optionId: "yes", kind: "allow_once" as const, name: "Allow once" }],
    },
  };
  const renderPage = (requests: typeof request[]) => (
    <>
      <div role="region" aria-label="Conversation messages" tabIndex={0} />
      <PermissionRequests conversations={[]} onOpen={vi.fn()} onAnswer={vi.fn()}
        requests={requests} />
    </>
  );
  const nextRequest = { ...request, id: "next-request" };
  const view = render(renderPage([request, nextRequest]));
  const button = screen.getAllByRole("button", { name: "Allow once" })[0]!;
  button.focus();
  fireEvent.click(button);
  view.rerender(renderPage([nextRequest]));
  const nextButton = screen.getByRole("button", { name: "Allow once" });
  expect(document.activeElement).toBe(nextButton);
  fireEvent.click(nextButton);
  view.rerender(renderPage([]));
  expect(document.activeElement).toBe(screen.getByRole("region", {
    name: "Conversation messages",
  }));
});
