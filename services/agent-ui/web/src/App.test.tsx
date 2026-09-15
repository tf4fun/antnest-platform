import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode, useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "./App";
import type { AgentConnectionListener, ConnectedAgent } from "./lib/client";
import type { Conversation, WorkspaceSnapshot } from "./lib/types";
import { appendLocalUserPrompt } from "./lib/acp-state";
import type { StateListener, WorkspaceState } from "./lib/workspace-state";

const client = vi.hoisted(() => ({
  loadWorkspace: vi.fn(),
  watchState: vi.fn(),
  connectAgent: vi.fn(),
  logout: vi.fn(),
}));
vi.mock("./lib/client", () => ({ createAgentUIClient: () => client }));
let listener: AgentConnectionListener;
let connection: ConnectedAgent;
let finishPrompt: () => void;
let current: Conversation;
let createdURLs: string[];
let revoke: ReturnType<typeof vi.fn>;
let stateListener: StateListener;
let prepare: (() => Promise<Conversation>) | undefined;
const readyState: WorkspaceState = {
  agent_id: "native",
  availability: "ready",
  access_allowed: true,
  configuration_revision: "a".repeat(64),
  unavailable_reason: null,
  active_session_id: null,
};
const native = { image: true, audio: true, embeddedContext: true };

beforeEach(() => {
  prepare = undefined;
  window.history.replaceState(null, "", "/workspace/?agent=native");
  const previewPrefix = crypto.randomUUID();
  createdURLs = [];
  revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL() {
        const url = `blob:${previewPrefix}-${createdURLs.length}`;
        createdURLs.push(url);
        return url;
      }
      static revokeObjectURL = revoke;
    },
  );
  current = {
    id: "session-1",
    agentId: "native",
    title: "Media review",
    updatedAt: new Date().toISOString(),
    messages: [],
  };
  const workspace: WorkspaceSnapshot = {
    principal: {
      userId: "u1",
      organizationId: "o1",
      displayName: "User",
      organizationName: "Org",
      administrator: false,
    },
    connection: "connecting",
    preview: false,
    activeAgentId: "native",
    activeConversationId: null,
    conversations: [],
    agents: ["native", "text"].map((id) => ({
      id,
      name: `${id} Agent`,
      status: "ready",
      managementState: {
        lifecycle: "created",
        activation: "enabled",
        runtime: "available",
      },
      description: "",
      modelLabel: "Model",
    })),
  };
  client.loadWorkspace.mockResolvedValue(workspace);
  client.watchState.mockImplementation(
    (id: string, callbacks: StateListener) => {
      stateListener = callbacks;
      queueMicrotask(() => callbacks.onState({ ...readyState, agent_id: id }));
      return vi.fn();
    },
  );
  client.connectAgent.mockImplementation(async (agentID, callbacks) => {
    listener = callbacks;
    connection = {
      promptCapabilities: agentID === "native" ? native : {},
      conversations: [],
      loadConversations: vi.fn(async () => ({
        conversations: connection.conversations,
        hasMore: false,
      })),
      createConversation: vi.fn(async () => {
        const created = prepare
          ? await prepare()
          : { ...current, agentId: agentID };
        callbacks.onConversation(created);
        return created;
      }),
      loadConversation: vi.fn(async () => {
        current = {
          ...current,
          messages: [
            {
              id: "replayed",
              role: "user",
              content: "Authoritative history",
              createdAt: new Date().toISOString(),
            },
          ],
        };
        listener.onConversation(current);
      }),
      prompt: vi.fn(async (_id, text, attachments) => {
        await new Promise<void>((resolve) => {
          finishPrompt = resolve;
        });
        current = appendLocalUserPrompt(current, text, attachments);
        listener.onConversation(current);
      }),
      close: vi.fn(),
      cancel: vi.fn(),
      answerPermission: vi.fn(),
      setConfiguration: vi.fn(),
    };
    listener.onConnection("ready");
    return connection;
  });
});

test("busy-to-ready recovery finishes before preparing the first Session", async () => {
  client.watchState.mockImplementation((_id, callbacks) => {
    stateListener = callbacks;
    queueMicrotask(() =>
      callbacks.onState({ ...readyState, availability: "busy" }),
    );
    return vi.fn();
  });
  const pending = Promise.withResolvers<Conversation>();
  const create = vi.fn(() => pending.promise);
  prepare = create;
  render(<App />);
  await waitFor(() => expect(client.connectAgent).toHaveBeenCalledTimes(1));
  expect(create).not.toHaveBeenCalled();
  await act(async () => stateListener.onState(readyState));
  await waitFor(() => expect(client.connectAgent).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  await act(async () => pending.resolve(current));
  await waitFor(() =>
    expect(new URLSearchParams(window.location.search).get("session")).toBe(
      current.id,
    ),
  );
  expect(connection.prompt).not.toHaveBeenCalled();
});

test("new conversation prepares once under StrictMode with no settings activation or prompt", async () => {
  const pending = Promise.withResolvers<Conversation>();
  prepare = () => pending.promise;
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await waitFor(() =>
    expect(connection.createConversation).toHaveBeenCalledTimes(1),
  );
  expect(
    screen.queryByRole("button", { name: "Conversation settings" }),
  ).toBeNull();
  expect(connection.prompt).not.toHaveBeenCalled();
  const length = window.history.length;
  await act(async () => pending.resolve(current));
  await waitFor(() =>
    expect(new URLSearchParams(window.location.search).get("session")).toBe(
      current.id,
    ),
  );
  expect(window.history.length).toBe(length);
  await act(async () => stateListener.onState(readyState));
  expect(connection.createConversation).toHaveBeenCalledTimes(1);
  expect(connection.prompt).not.toHaveBeenCalled();
});

test("failed automatic preparation never loops and explicit New conversation retries", async () => {
  prepare = async () => {
    throw new Error("Preparation unavailable");
  };
  render(<App />);
  await screen.findByText("Preparation unavailable");
  await act(async () => stateListener.onState(readyState));
  expect(connection.createConversation).toHaveBeenCalledTimes(1);
  expect(connection.prompt).not.toHaveBeenCalled();
  prepare = undefined;
  fireEvent.click(
    screen.getAllByRole("button", { name: "New conversation", exact: true })[0],
  );
  await waitFor(() =>
    expect(connection.createConversation).toHaveBeenCalledTimes(2),
  );
  await waitFor(() =>
    expect(new URLSearchParams(window.location.search).get("session")).toBe(
      current.id,
    ),
  );
});

test("a late preparation response cannot take over a selected existing Session", async () => {
  const pending = Promise.withResolvers<Conversation>();
  prepare = () => pending.promise;
  render(<App />);
  await waitFor(() =>
    expect(connection.createConversation).toHaveBeenCalledTimes(1),
  );
  const other = { ...current, id: "other", title: "Other conversation" };
  await act(async () => listener.onConversation(other));
  fireEvent.click(screen.getByRole("button", { name: /Other conversation/ }));
  await act(async () => pending.resolve(current));
  expect(new URLSearchParams(window.location.search).get("session")).toBe(
    "other",
  );
  expect(connection.prompt).not.toHaveBeenCalled();
});

afterEach(() => {
  cleanup();
});

test("the entry is an Agent chooser and opens no connection until selection", async () => {
  const initial = await client.loadWorkspace();
  client.loadWorkspace.mockResolvedValue({ ...initial, activeAgentId: "" });
  window.history.replaceState(null, "", "/workspace/");
  render(<App />);
  await screen.findByRole("heading", { name: "Your agents" });
  expect(client.connectAgent).not.toHaveBeenCalled();
  expect(client.watchState).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Refresh agents" }));
  await waitFor(() => expect(client.loadWorkspace).toHaveBeenCalledTimes(3));
  expect(client.connectAgent).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("link", { name: /text Agent/ }));
  await waitFor(() => expect(client.connectAgent).toHaveBeenCalledTimes(1));
  expect(new URLSearchParams(window.location.search).get("agent")).toBe("text");
  await waitFor(() =>
    expect(connection.createConversation).toHaveBeenCalledTimes(1),
  );
});

test("process folding follows the selected Session, including re-entered work from another connection", async () => {
  await openWorkspace();
  current = {
    ...current,
    messages: [
      { id: "question", role: "user", content: "Check numbers" },
      { id: "progress", role: "assistant", content: "Checking numbers now" },
      { id: "result", role: "assistant", content: "Numbers verified" },
    ],
  };
  vi.mocked(connection.loadConversation).mockImplementation(async () => {
    listener.onConversation(current);
  });
  const connect = client.connectAgent.getMockImplementation()!;
  client.connectAgent.mockImplementation(async (...args) => {
    const reopened = await connect(...args);
    reopened.loadConversation = async () => {
      listener.onConversation(current);
    };
    return reopened;
  });
  await act(async () => listener.onConversation(current));
  fireEvent.click(screen.getByRole("button", { name: /Media review/ }));
  await screen.findByRole("button", { name: "Show process" });
  await act(async () =>
    stateListener.onState({
      ...readyState,
      availability: "busy",
      active_session_id: "other-session",
    }),
  );
  expect(screen.getByRole("button", { name: "Show process" })).toBeTruthy();
  expect(document.querySelector(".agent-working")).toBeNull();
  await act(async () =>
    stateListener.onState({
      ...readyState,
      availability: "busy",
      active_session_id: current.id,
    }),
  );
  expect(screen.queryByRole("button", { name: "Show process" })).toBeNull();
  expect(document.querySelector(".agent-working")?.textContent).toBe("Working");
  await act(async () => stateListener.onState(readyState));
  await screen.findByRole("button", { name: "Show process" });
});

test("Session deep links survive catalog absence and never open a different conversation", async () => {
  const initial = await client.loadWorkspace();
  client.loadWorkspace.mockResolvedValue({
    ...initial,
    activeConversationId: "missing-session",
  });
  window.history.replaceState(
    null,
    "",
    "/workspace/?agent=native&session=missing-session",
  );
  render(<App />);
  await waitFor(() =>
    expect(connection.loadConversation).toHaveBeenCalledWith("missing-session"),
  );
  expect(new URLSearchParams(window.location.search).get("session")).toBe(
    "missing-session",
  );
  expect(connection.createConversation).not.toHaveBeenCalled();
});

test("drafts remain separate in each Agent and Session memory projection", async () => {
  await openWorkspace();
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
    target: { value: "Native draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: /text Agent/ }));
  await waitFor(() => expect(client.connectAgent).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" })
        .disabled,
    ).toBe(false),
  );
  expect(
    (screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
      .value,
  ).toBe("");
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
    target: { value: "Text draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: /native Agent/ }));
  await waitFor(() => expect(client.connectAgent).toHaveBeenCalledTimes(3));
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" })
        .disabled,
    ).toBe(false),
  );
  expect(
    (screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
      .value,
  ).toBe("Native draft");
  await act(async () =>
    listener.onConversation({
      ...current,
      id: "second",
      title: "Second conversation",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Second conversation/ }));
  expect(
    (screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
      .value,
  ).toBe("");
});

test("Back navigation returns to Agent selection without sending or cancelling work", async () => {
  await openWorkspace();
  const previous = connection;
  await act(async () => {
    window.history.replaceState(null, "", "/workspace/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await screen.findByRole("heading", { name: "Your agents" });
  expect(previous.close).toHaveBeenCalled();
  expect(previous.cancel).not.toHaveBeenCalled();
  expect(previous.prompt).not.toHaveBeenCalled();
});

test("a pending prompt cannot take over a later Session selection", async () => {
  await openWorkspace();
  const other = { ...current, id: "other", title: "Another conversation" };
  await act(async () => listener.onConversation(other));
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
    target: { value: "Initial request" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(connection.createConversation).toHaveBeenCalledTimes(1),
  );
  fireEvent.click(screen.getByRole("button", { name: /Another conversation/ }));
  await waitFor(() => expect(connection.prompt).toHaveBeenCalledTimes(1));
  expect(new URLSearchParams(window.location.search).get("session")).toBe(
    "other",
  );
  await act(async () => finishPrompt());
  expect(new URLSearchParams(window.location.search).get("session")).toBe(
    "other",
  );
});

test("copy failure is local feedback when Clipboard API is unavailable", async () => {
  await openWorkspace();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
  await act(async () => listener.onConversation(current));
  fireEvent.click(screen.getByRole("button", { name: /Media review/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Copy prompt" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Copy prompt" }).title).toBe(
      "Copy failed. Try again",
    ),
  );
  expect(screen.getByText("Copy failed. Try again").getAttribute("role")).toBe(
    "status",
  );
});

async function openWorkspace() {
  const view = render(<App />);
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Attach files",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  return view;
}

test("first-message settings preserve the draft and use server model/thinking options", async () => {
  current.configOptions = [
    {
      id: "model",
      name: "Model",
      type: "select",
      category: "model",
      currentValue: "flash",
      options: [
        {
          group: "deepseek",
          name: "DeepSeek",
          options: [
            { value: "flash", name: "Flash" },
            { value: "pro", name: "Pro" },
          ],
        },
      ],
    },
    {
      id: "thinking_effort",
      name: "Thinking",
      type: "select",
      category: "thought_level",
      currentValue: "default",
      options: [
        { value: "default", name: "Model default" },
        { value: "max", name: "Max" },
      ],
    },
  ];
  const view = await openWorkspace();
  selectFile(
    view.container,
    new File(["notes"], "notes.txt", { type: "text/plain" }),
  );
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Message",
  });
  fireEvent.change(input, { target: { value: "Keep my unsent question" } });
  const thinking = await screen.findByRole<HTMLButtonElement>("combobox", {
    name: "Thinking",
  });
  await waitFor(() => expect(thinking.disabled).toBe(false));
  expect(input.value).toBe("Keep my unsent question");
  expect(screen.getByRole("button", { name: "Remove notes.txt" })).toBeTruthy();
  expect(connection.createConversation).toHaveBeenCalledTimes(1);
  expect(connection.prompt).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
  expect(screen.getByRole("group", { name: "DeepSeek" })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("option", { name: "Flash" }), {
    key: "Escape",
  });
  vi.mocked(connection.setConfiguration).mockImplementation(
    async (_session, id, value) => {
      current = {
        ...current,
        configOptions: current.configOptions!.map((option) =>
          option.id === id ? { ...option, currentValue: value } : option,
        ),
      };
      listener.onConversation(current);
    },
  );
  fireEvent.click(thinking);
  fireEvent.click(screen.getByRole("option", { name: "Max" }));
  await waitFor(() => expect(thinking.textContent).toContain("Max"));
  expect(connection.setConfiguration).toHaveBeenCalledWith(
    "session-1",
    "thinking_effort",
    "max",
  );
  expect(input.value).toBe("Keep my unsent question");
});

test("failed explicit new conversation keeps the existing draft and permits retry", async () => {
  await openWorkspace();
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Message",
  });
  fireEvent.change(input, { target: { value: "Do not lose this" } });
  let reject!: (error: Error) => void;
  vi.mocked(connection.createConversation).mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const configure = screen.getAllByRole<HTMLButtonElement>("button", {
    name: "New conversation",
    exact: true,
  })[0];
  fireEvent.click(configure);
  expect(configure.disabled).toBe(true);
  expect(input.disabled).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Send message" })
      .disabled,
  ).toBe(true);
  await act(async () => reject(new Error("Configuration unavailable")));
  expect(configure.disabled).toBe(false);
  expect(input.value).toBe("Do not lose this");
  expect(connection.prompt).not.toHaveBeenCalled();
});

test("composer owns ACP settings and pending changes prevent sending", async () => {
  await openWorkspace();
  current = {
    ...current,
    usage: { used: 100, size: 1000 },
    configOptions: [
      {
        id: "mode",
        name: "Mode",
        type: "select",
        currentValue: "ask",
        options: [
          {
            group: "permissions",
            name: "Permissions",
            options: [
              { value: "ask", name: "Ask first" },
              { value: "allow", name: "Allow" },
            ],
          },
        ],
      },
    ],
  };
  vi.mocked(connection.loadConversation).mockImplementation(async () =>
    listener.onConversation(current),
  );
  await act(async () => listener.onConversation(current));
  fireEvent.click(screen.getByRole("button", { name: /Media review/ }));
  const composer = within(
    await screen.findByRole("group", { name: "Message composer" }),
  );
  const mode = await composer.findByRole<HTMLButtonElement>("combobox", {
    name: "Mode",
  });
  await waitFor(() => expect(mode.disabled).toBe(false));
  expect(composer.getByRole("button", { name: /Context usage/ })).toBeTruthy();
  fireEvent.click(mode);
  expect(screen.getByRole("group", { name: "Permissions" })).toBeTruthy();
  let finish!: () => void;
  vi.mocked(connection.setConfiguration).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByRole("option", { name: "Allow", exact: true }));
  expect(connection.setConfiguration).toHaveBeenCalledWith(
    "session-1",
    "mode",
    "allow",
  );
  expect(mode.disabled).toBe(true);
  expect(
    composer.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" })
      .disabled,
  ).toBe(true);
  await act(async () => finish());
  expect(mode.disabled).toBe(false);
  expect(
    composer.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" })
      .disabled,
  ).toBe(false);
});

function selectFile(
  container: HTMLElement,
  file = new File(["voice"], "voice.wav", { type: "audio/wav" }),
) {
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [file] },
  });
}

function UploadOnCommit({ selected }: { selected: boolean }) {
  useLayoutEffect(() => {
    if (!selected) return;
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["voice"], "voice.wav", { type: "audio/wav" })],
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, [selected]);
  return null;
}

test("a pending history effect cannot reclaim a newly selected preview", async () => {
  const content = (selected: boolean) => (
    <>
      <App />
      <UploadOnCommit selected={selected} />
    </>
  );
  const view = render(content(false));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Attach files",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  await act(async () => {
    listener.onConversation(current);
    view.rerender(content(true));
  });
  expect(screen.getByRole("button", { name: "Remove voice.wav" })).toBeTruthy();
  expect(createdURLs).toHaveLength(1);
  expect(revoke).not.toHaveBeenCalled();
  view.unmount();
  expect(revoke).toHaveBeenCalledExactlyOnceWith(createdURLs[0]);
});

test("selecting the current Agent keeps its connection and draft usable", async () => {
  const { container } = await openWorkspace();
  selectFile(container);
  fireEvent.click(screen.getByRole("button", { name: /native Agent/ }));
  expect(client.connectAgent).toHaveBeenCalledTimes(1);
  expect(
    (screen.getByRole("button", { name: "Attach files" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(screen.getByRole("button", { name: "Remove voice.wav" })).toBeTruthy();
});

test("changing Agent updates negotiated formats rather than retaining old capabilities", async () => {
  const { container } = await openWorkspace();
  expect(container.querySelector('input[type="file"]')!.accept).toContain(
    ".wav",
  );
  fireEvent.click(screen.getByRole("button", { name: /text Agent/ }));
  await waitFor(() => expect(client.connectAgent).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" })
        .disabled,
    ).toBe(false),
  );
  expect(container.querySelector('input[type="file"]')!.accept).not.toContain(
    ".wav",
  );
  expect(container.querySelector('input[type="file"]')!.accept).not.toContain(
    ".pdf",
  );
  selectFile(container);
  expect(screen.getByRole("alert").textContent).toMatch(
    /does not accept audio/,
  );
  expect(createdURLs).toEqual([]);
});

test("preview URLs survive file reading and local history, then release after authoritative replay", async () => {
  const { container, unmount } = await openWorkspace();
  selectFile(container);
  expect(revoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(connection.prompt).toHaveBeenCalledTimes(1));
  expect(vi.mocked(connection.prompt).mock.calls[0][2][0].previewURL).toBe(
    createdURLs[0],
  );
  expect(revoke).not.toHaveBeenCalled();
  await act(async () => finishPrompt());
  expect(container.querySelector("audio")!.src).toBe(createdURLs[0]);
  expect(revoke).not.toHaveBeenCalled();
  fireEvent.click(container.querySelector(".conversation-option")!);
  await waitFor(() => expect(revoke).toHaveBeenCalledWith(createdURLs[0]));
  unmount();
  expect(revoke).toHaveBeenCalledTimes(1);
});

test("rejected drafts allocate no preview and removing the last reference releases it", async () => {
  const { container } = await openWorkspace();
  selectFile(
    container,
    new File([new Uint8Array(1_048_577)], "large.wav", { type: "audio/wav" }),
  );
  expect(screen.getByRole("alert").textContent).toMatch(/1 MiB/);
  expect(createdURLs).toEqual([]);
  selectFile(container);
  fireEvent.click(screen.getByRole("button", { name: "Remove voice.wav" }));
  expect(revoke).toHaveBeenCalledExactlyOnceWith(createdURLs[0]);
});

test("failed submission restores the draft without revoking its preview", async () => {
  const { container } = await openWorkspace();
  vi.mocked(connection.prompt).mockRejectedValueOnce(
    new Error("Model does not accept audio"),
  );
  selectFile(container);
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
    target: { value: "Listen" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByRole("alert");
  expect(
    (screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
      .value,
  ).toBe("Listen");
  expect(screen.getByRole("button", { name: "Remove voice.wav" })).toBeTruthy();
  expect(revoke).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Send message",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
});

test("removing a retry draft does not revoke a preview still referenced by local history", async () => {
  const { container, unmount } = await openWorkspace();
  vi.mocked(connection.prompt).mockImplementationOnce(
    async (_id, text, attachments) => {
      current = appendLocalUserPrompt(current, text, attachments);
      listener.onConversation(current);
      throw new Error("Connection lost before authoritative replay");
    },
  );
  selectFile(container);
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Remove voice.wav" }));
  expect(container.querySelector("audio")!.src).toBe(createdURLs[0]);
  expect(revoke).not.toHaveBeenCalled();
  unmount();
  expect(revoke).toHaveBeenCalledExactlyOnceWith(createdURLs[0]);
});

test("stop remains bound to the submitted Session after selecting another conversation", async () => {
  await openWorkspace();
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
    target: { value: "Work" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(connection.prompt).toHaveBeenCalledTimes(1));
  await act(async () =>
    listener.onConversation({
      ...current,
      id: "session-2",
      title: "Other chat",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Other chat/ }));
  fireEvent.click(screen.getByRole("button", { name: "Stop operation" }));
  await waitFor(() =>
    expect(connection.cancel).toHaveBeenCalledExactlyOnceWith("session-1"),
  );
  expect(
    (screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
      .disabled,
  ).toBe(true);
  await act(async () => finishPrompt());
});

test("prompt completion obtains fresh state and bootstrap cannot overwrite subscribed busy", async () => {
  await openWorkspace();
  const initial = await client.loadWorkspace();
  client.loadWorkspace.mockResolvedValue(initial);
  client.watchState.mockImplementationOnce((_id, callbacks) => {
    queueMicrotask(() =>
      callbacks.onState({ ...readyState, availability: "busy" }),
    );
    return vi.fn();
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
    target: { value: "Work" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(connection.prompt).toHaveBeenCalledTimes(1));
  await act(async () => finishPrompt());
  expect(
    (screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
      .disabled,
  ).toBe(true);
  expect(screen.queryByRole("button", { name: "Stop operation" })).toBeNull();
});

test("failed availability refresh closes submission and explicit refresh never repeats the prompt", async () => {
  await openWorkspace();
  const initial = await client.loadWorkspace();
  client.loadWorkspace.mockRejectedValueOnce(
    new Error("Availability unavailable"),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
    target: { value: "Work" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(connection.prompt).toHaveBeenCalledTimes(1));
  const previous = connection;
  await act(async () => finishPrompt());
  expect(
    (screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
      .disabled,
  ).toBe(true);
  client.loadWorkspace.mockResolvedValue(initial);
  fireEvent.click(screen.getByRole("button", { name: "Refresh workspace" }));
  await waitFor(() => expect(client.connectAgent).toHaveBeenCalledTimes(2));
  expect(previous.prompt).toHaveBeenCalledTimes(1);
  expect(connection.prompt).not.toHaveBeenCalled();
  expect(previous.close).toHaveBeenCalled();
});

test("failed history with an empty error message still gates submission and exposes retry", async () => {
  await openWorkspace();
  vi.mocked(connection.loadConversation).mockRejectedValueOnce(new Error(""));
  await act(async () => listener.onConversation(current));
  fireEvent.click(screen.getByRole("button", { name: /Media review/ }));
  await screen.findByRole("button", { name: "Retry conversation" });
  expect(
    (screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
      .disabled,
  ).toBe(true);
});

test("late connection completion preserves a newer conversation selection", async () => {
  await openWorkspace();
  const conversations = [
    current,
    { ...current, id: "session-2", title: "Second chat" },
  ];
  await act(async () =>
    conversations.forEach((value) => listener.onConversation(value)),
  );
  fireEvent.click(screen.getByRole("button", { name: /Media review/ }));
  let complete!: () => void;
  const next = {
    ...connection,
    conversations,
    loadConversation: vi.fn(async () => {}),
  };
  client.connectAgent.mockImplementationOnce(async (_id, callbacks) => {
    await new Promise<void>((resolve) => {
      complete = resolve;
    });
    callbacks.onConnection("ready");
    return next;
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh workspace" }));
  await waitFor(() => expect(complete).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("button", { name: /Second chat/ }));
  await act(async () => complete());
  await waitFor(() =>
    expect(next.loadConversation).toHaveBeenCalledWith("session-2"),
  );
  expect(document.querySelector(".topbar-agent small")!.textContent).toBe(
    "Second chat",
  );
});

test("failed refresh invalidates an unresolved connection instead of accepting its late ready callback", async () => {
  let complete!: () => void;
  const stale = {
    close: vi.fn(),
    conversations: [],
    promptCapabilities: {},
  } as unknown as ConnectedAgent;
  client.connectAgent.mockImplementationOnce(async (_id, callbacks) => {
    await new Promise<void>((resolve) => {
      complete = resolve;
    });
    callbacks.onConnection("ready");
    return stale;
  });
  render(<App />);
  await waitFor(() => expect(complete).toBeTypeOf("function"));
  client.loadWorkspace.mockRejectedValueOnce(new Error("Refresh unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh workspace" }));
  await screen.findByRole("alert");
  await act(async () => complete());
  expect(stale.close).toHaveBeenCalled();
  expect(
    (screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
      .disabled,
  ).toBe(true);
});

test("refresh immediately removes approvals from the disposed connection even when bootstrap fails", async () => {
  await openWorkspace();
  await act(async () =>
    listener.onPermissions([
      {
        id: "p1",
        request: {
          sessionId: "session-1",
          toolCall: { toolCallId: "t1", title: "Write file" },
          options: [
            { optionId: "allow", kind: "allow_once", name: "Allow once" },
          ],
        },
      },
    ]),
  );
  expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();
  client.loadWorkspace.mockRejectedValueOnce(
    new Error("Bootstrap unavailable"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh workspace" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
});

test("available management state and ACP connection do not unlock input before the execution snapshot", async () => {
  client.watchState.mockImplementationOnce((_id, callbacks) => {
    stateListener = callbacks;
    return vi.fn();
  });
  render(<App />);
  await waitFor(() => expect(client.connectAgent).toHaveBeenCalledTimes(1));
  expect(
    (screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
      .disabled,
  ).toBe(true);
  await act(async () => stateListener.onState(readyState));
  await waitFor(() =>
    expect(
      (screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
        .disabled,
    ).toBe(false),
  );
});

test("remote busy state blocks every conversation and Stop targets the scoped active Session", async () => {
  await openWorkspace();
  await act(async () => {
    listener.onConversation({ ...current, id: "s-other", title: "Other chat" });
    stateListener.onState({
      ...readyState,
      availability: "busy",
      active_session_id: "remote-session",
    });
  });
  fireEvent.click(screen.getByRole("button", { name: /Other chat/ }));
  expect(
    (screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Stop operation" }));
  await waitFor(() =>
    expect(connection.cancel).toHaveBeenCalledWith("remote-session"),
  );
  expect(
    (screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
      .disabled,
  ).toBe(true);
  await act(async () => stateListener.onState(readyState));
  await waitFor(() =>
    expect(
      (screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
        .disabled,
    ).toBe(false),
  );
});

test("busy without an owned Session cannot cancel another principal's work", async () => {
  await openWorkspace();
  await act(async () =>
    stateListener.onState({ ...readyState, availability: "busy" }),
  );
  expect(
    (screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.queryByRole("button", { name: "Stop operation" })).toBeNull();
  expect(connection.cancel).not.toHaveBeenCalled();
});

test("lost observation closes sending but preserves the ACP Stop for a local prompt", async () => {
  await openWorkspace();
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
    target: { value: "Work" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(connection.prompt).toHaveBeenCalledTimes(1));
  await act(async () => stateListener.onDisconnect());
  expect(connection.close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Stop operation" }));
  await waitFor(() =>
    expect(connection.cancel).toHaveBeenCalledWith("session-1"),
  );
  await act(async () => finishPrompt());
});

test("terminal access loss removes cached history, closes ACP and ignores stale callbacks", async () => {
  await openWorkspace();
  const previous = connection;
  const stale = listener;
  await act(async () =>
    listener.onConversation({
      ...current,
      messages: [
        {
          id: "private",
          role: "assistant",
          content: "Private answer",
          createdAt: "2026-01-01",
        },
      ],
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Media review/ }));
  await act(async () =>
    stateListener.onState({
      ...readyState,
      availability: "offline",
      access_allowed: false,
      configuration_revision: null,
      unavailable_reason: "access_denied",
    }),
  );
  await waitFor(() => expect(previous.close).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: /native Agent/ })).toBeNull();
  await act(async () =>
    stale.onConversation({ ...current, title: "Stale private chat" }),
  );
  expect(screen.queryByText("Stale private chat")).toBeNull();
});

test("bootstrap identity switch discards old history even when the Agent ID remains accessible", async () => {
  await openWorkspace();
  const previous = connection;
  const stale = listener;
  const initial = await client.loadWorkspace();
  await act(async () =>
    listener.onConversation({ ...current, title: "Private old chat" }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
    target: { value: "Private draft" },
  });
  client.loadWorkspace.mockResolvedValue({
    ...initial,
    principal: { ...initial.principal, userId: "new-user" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh workspace" }));
  await waitFor(() => expect(previous.close).toHaveBeenCalled());
  await screen.findByRole("heading", { name: "Your agents" });
  fireEvent.click(await screen.findByRole("link", { name: /native Agent/ }));
  await waitFor(() => expect(client.connectAgent).toHaveBeenCalledTimes(2));
  await act(async () =>
    stale.onConversation({ ...current, title: "Private old chat" }),
  );
  expect(screen.queryByText("Private old chat")).toBeNull();
  expect(
    (screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
      .value,
  ).toBe("");
});

test("revision recovery waits for the current prompt and never resubmits it", async () => {
  await openWorkspace();
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
    target: { value: "Work" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(connection.prompt).toHaveBeenCalledTimes(1));
  const previous = connection;
  await act(async () =>
    stateListener.onState({
      ...readyState,
      configuration_revision: "b".repeat(64),
      unavailable_reason: null,
    }),
  );
  expect(previous.close).not.toHaveBeenCalled();
  await act(async () => finishPrompt());
  await waitFor(() => expect(client.connectAgent).toHaveBeenCalledTimes(2));
  expect(previous.prompt).toHaveBeenCalledTimes(1);
  expect(connection.prompt).not.toHaveBeenCalled();
});

test("revocation during prompt does not restore its private draft after a late failure", async () => {
  await openWorkspace();
  let reject!: (cause: Error) => void;
  vi.mocked(connection.prompt).mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
    target: { value: "Private prompt" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(connection.prompt).toHaveBeenCalledTimes(1));
  await act(async () =>
    stateListener.onState({
      ...readyState,
      access_allowed: false,
      availability: "offline",
      configuration_revision: null,
      unavailable_reason: "access_denied",
    }),
  );
  await act(async () => reject(new Error("Old private failure")));
  expect(screen.queryByText("Old private failure")).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: /text Agent/ }));
  expect(
    (screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
      .value,
  ).toBe("");
});

test("lost state while creating a Session cannot send the prepared prompt afterward", async () => {
  const pending = Promise.withResolvers<Conversation>();
  prepare = () => pending.promise;
  render(<App />);
  await waitFor(() =>
    expect(connection.createConversation).toHaveBeenCalledTimes(1),
  );
  await act(async () => stateListener.onDisconnect());
  await act(async () => pending.resolve(current));
  expect(connection.prompt).not.toHaveBeenCalled();
  expect(
    (screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
      .disabled,
  ).toBe(true);
});

test("recovered busy in the same Session permits another Stop without assuming an idle transition", async () => {
  await openWorkspace();
  const busy: WorkspaceState = {
    ...readyState,
    availability: "busy",
    active_session_id: "s1",
  };
  await act(async () => stateListener.onState(busy));
  fireEvent.click(screen.getByRole("button", { name: "Stop operation" }));
  await waitFor(() => expect(connection.cancel).toHaveBeenCalledTimes(1));
  expect(
    (
      screen.getByRole("button", {
        name: "Stop operation",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  client.watchState.mockImplementationOnce((_id, callbacks) => {
    stateListener = callbacks;
    queueMicrotask(() => callbacks.onState(busy));
    return vi.fn();
  });
  await act(async () => stateListener.onDisconnect());
  await waitFor(() => expect(client.watchState).toHaveBeenCalledTimes(2), {
    timeout: 2500,
  });
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Stop operation",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Stop operation" }));
  await waitFor(() => expect(connection.cancel).toHaveBeenCalledTimes(2));
});
