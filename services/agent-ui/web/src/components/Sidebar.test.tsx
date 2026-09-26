import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { Sidebar } from "./Sidebar";

afterEach(cleanup);

function props(): ComponentProps<typeof Sidebar> {
  return {
    agents: ["One", "Two"].map((name, index) => ({
      id: `agent-${index + 1}`,
      name,
      description: "",
      modelLabel: "Model",
      status: "ready",
      managementState: {
        lifecycle: "created",
        activation: "enabled",
        runtime: "available",
      },
    })),
    conversations: ["First task", "Second task"].map((title, index) => ({
      id: `session-${index + 1}`,
      agentId: `agent-${index + 1}`,
      title,
      updatedAt: "2026-09-26T00:00:00Z",
      messages: [],
    })),
    activeAgentId: "agent-1",
    activeConversationId: "session-1",
    principal: {
      userId: "user",
      organizationId: "org",
      displayName: "User",
      organizationName: "Org",
      administrator: false,
    },
    open: false,
    agentSwitchDisabled: false,
    newConversationDisabled: false,
    logoutDisabled: false,
    onClose: vi.fn(),
    onSelectAgent: vi.fn(),
    onSelectConversation: vi.fn(),
    onNewConversation: vi.fn(),
    onLogout: vi.fn(),
    onChooseAgent: vi.fn(),
    catalogDisabled: false,
    catalog: { loading: false, hasMore: false, loadMore: vi.fn() },
  };
}

test("workspace context precedes its new conversation, search and history", () => {
  const model = props();
  render(<Sidebar {...model} />);
  const workspace = screen.getByRole("button", {
    name: "Switch workspace: One",
  });
  const conversations = screen.getByRole("region", {
    name: "Conversations in One",
  });
  const create = within(conversations).getByRole("button", {
    name: "New conversation",
  });
  expect(
    workspace.compareDocumentPosition(create) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(conversations.contains(workspace)).toBe(false);
  expect(
    within(conversations).getByRole("searchbox", {
      name: "Search conversations",
    }),
  ).toBeTruthy();
  expect(
    within(conversations).getByRole("button", { name: /First task/ }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Second task/ })).toBeNull();
  expect(screen.queryByRole("group", { name: "Workspaces" })).toBeNull();
  fireEvent.click(create);
  expect(model.onNewConversation).toHaveBeenCalledOnce();
});

test("switching workspace clears the previous search and scopes history to the new Agent", () => {
  const model = props();
  const { rerender } = render(<Sidebar {...model} />);
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "First" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Switch workspace: One" }),
  );
  fireEvent.click(
    within(screen.getByRole("group", { name: "Workspaces" })).getByRole(
      "button",
      { name: /Two/ },
    ),
  );
  expect(model.onSelectAgent).toHaveBeenCalledWith("agent-2");
  rerender(
    <Sidebar {...model} activeAgentId="agent-2" activeConversationId={null} />,
  );
  expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
  expect(
    screen.getByRole("region", { name: "Conversations in Two" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: /Second task/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /First task/ })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Switch workspace: Two" }),
  );
  expect(document.activeElement).toBe(
    within(screen.getByRole("group", { name: "Workspaces" })).getByRole(
      "button",
      { name: /Two/ },
    ),
  );
});

test("workspace disclosure closes on Escape, outside click and focus leaving it", () => {
  render(<Sidebar {...props()} />);
  const trigger = screen.getByRole("button", { name: "Switch workspace: One" });
  fireEvent.click(trigger);
  const current = within(
    screen.getByRole("group", { name: "Workspaces" }),
  ).getByRole("button", { name: /One/ });
  expect(document.activeElement).toBe(current);
  fireEvent.keyDown(current, { key: "Escape" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("group", { name: "Workspaces" })).toBeNull();
  fireEvent.click(trigger);
  fireEvent.blur(document.activeElement!, {
    relatedTarget: screen.getByRole("searchbox"),
  });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

test("reselecting the current workspace keeps the open conversation", () => {
  const model = props();
  render(<Sidebar {...model} />);
  const trigger = screen.getByRole("button", { name: "Switch workspace: One" });
  fireEvent.click(trigger);
  fireEvent.click(
    within(screen.getByRole("group", { name: "Workspaces" })).getByRole(
      "button",
      { name: /One/ },
    ),
  );
  expect(model.onSelectAgent).not.toHaveBeenCalled();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
});

test("the collapsed rail keeps workspace selection above new conversation", () => {
  const model = props();
  const { container } = render(<Sidebar {...model} />);
  fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  expect(
    container.querySelector("aside.sidebar")?.getAttribute("data-collapsed"),
  ).toBe("true");
  const workspace = screen.getByRole("button", {
    name: "Switch workspace: One",
  });
  const create = screen.getByRole("button", { name: "New conversation" });
  expect(
    workspace.compareDocumentPosition(create) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(workspace);
  fireEvent.click(screen.getByRole("button", { name: "All workspaces" }));
  expect(model.onChooseAgent).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
  expect(
    container.querySelector("aside.sidebar")?.getAttribute("data-collapsed"),
  ).toBe("false");
});

test("workspace refresh disables switching without hiding the current context", () => {
  const model = props();
  render(<Sidebar {...model} agentSwitchDisabled />);
  fireEvent.click(
    screen.getByRole("button", { name: "Switch workspace: One" }),
  );
  const menu = within(screen.getByRole("group", { name: "Workspaces" }));
  expect(
    (menu.getByRole("button", { name: /Two/ }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    (menu.getByRole("button", { name: /One/ }) as HTMLButtonElement).disabled,
  ).toBe(false);
});

test("collapsing the sidebar preserves the current workspace's search", () => {
  render(<Sidebar {...props()} />);
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "First" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
  expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe(
    "First",
  );
});
