import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useState, type ComponentProps } from "react";
import { Composer } from "./Composer";

afterEach(cleanup);
const props = () => ({
  fileAccept: "image/*",
  configuring: false,
  historyReady: true,
  value: "An unsent draft",
  attachments: [],
  agentStatus: "ready" as const,
  connected: true,
  sending: false,
  cancelling: false,
  cancellable: false,
  onChange: vi.fn(),
  onFiles: vi.fn(),
  onRemoveAttachment: vi.fn(),
  onCancel: vi.fn(),
  onSubmit: vi.fn(),
});

const commands = [
  { name: "help", description: "Show available commands" },
  { name: "plan", description: "Plan a task", input: { hint: "Describe your task" } },
];

test("lists preset and personal Skill commands and selects one into an unsent task draft", () => {
  const submit = vi.fn();
  const skills = [
    { name: "skill:system:review", description: "Review files", input: { hint: "Task for this preset Skill" } },
    { name: "skill:personal:review", description: "Review my workspace", input: { hint: "Task for this personal Skill" } },
  ];
  render(<EditableComposer value="/skill" commands={skills} draftMode historyReady={false} onSubmit={submit} />);
  const editor = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
  fireEvent.focus(editor);
  expect(screen.getAllByRole("option")).toHaveLength(2);
  expect(screen.getByText("Preset Skill")).toBeTruthy();
  expect(screen.getByText("Personal Skill")).toBeTruthy();
  fireEvent.click(screen.getByRole("option", { name: /skill:personal:review/ }));
  expect(editor.value).toBe("/skill:personal:review ");
  expect(submit).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(editor);
});

test("busy command input stays editable and sends controls without invoking Stop", () => {
  const input = props();
  render(<Composer {...input} value="/status" sending cancellable agentStatus="busy"
    allowControlInput controlEnabled controlInput />);
  const editor = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
  expect(editor.disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Run command" }));
  expect(input.onSubmit).toHaveBeenCalledOnce(); expect(input.onCancel).not.toHaveBeenCalled();
});

test("a busy ordinary draft remains unsent while control input is enabled", () => {
  const input = props();
  render(<Composer {...input} sending cancellable agentStatus="busy" allowControlInput />);
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Message" }), { key: "Enter" });
  expect(input.onSubmit).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Stop operation" })).toBeTruthy();
});
function EditableComposer(input: Partial<ComponentProps<typeof Composer>>) {
  const [value, setValue] = useState(input.value ?? "");
  return <Composer {...props()} commands={commands} {...input} value={value} onChange={setValue} />;
}

test.each(["busy", "offline"] as const)("%s lifecycle state blocks ordinary prompts while preserving command input", (agentStatus) => {
  const input = props();
  const view = render(<Composer {...input} agentStatus={agentStatus} allowControlInput />);
  const editor = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
  expect(editor.disabled).toBe(false);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send message" }).disabled).toBe(true);
  fireEvent.keyDown(editor, { key: "Enter" });
  expect(input.onSubmit).not.toHaveBeenCalled();
  view.rerender(<Composer {...input} agentStatus={agentStatus} allowControlInput value="/status" controlInput controlEnabled />);
  fireEvent.click(screen.getByRole("button", { name: "Run command" }));
  expect(input.onSubmit).toHaveBeenCalledOnce();
});

test("slash filters advertised commands and Enter completes before submitting", () => {
  const submit = vi.fn();
  render(<EditableComposer onSubmit={submit} />);
  const editor = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
  fireEvent.focus(editor);
  fireEvent.change(editor, { target: { value: "/" } });
  const menu = screen.getByRole("listbox", { name: "Available commands" });
  expect(editor.getAttribute("aria-controls")).toBe(menu.id);
  expect(screen.getAllByRole("option")).toHaveLength(2);
  expect(screen.getByText("Describe your task")).toBeTruthy();
  fireEvent.change(editor, { target: { value: "/HE" } });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  fireEvent.keyDown(editor, { key: "Enter" });
  expect(editor.value).toBe("/help");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(submit).not.toHaveBeenCalled();
  fireEvent.keyDown(editor, { key: "Enter" });
  expect(submit).toHaveBeenCalledOnce();
});

test("command navigation wraps, Tab completes arguments and click keeps editor focus", () => {
  const submit = vi.fn();
  render(<EditableComposer value="/" onSubmit={submit} />);
  const editor = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
  fireEvent.focus(editor);
  fireEvent.keyDown(editor, { key: "ArrowUp" });
  expect(screen.getAllByRole("option")[1]?.getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(editor, { key: "ArrowDown" });
  expect(screen.getAllByRole("option")[0]?.getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(editor, { key: "ArrowDown" });
  fireEvent.keyDown(editor, { key: "Tab" });
  expect(editor.value).toBe("/plan ");
  expect(document.activeElement).toBe(editor);
  fireEvent.change(editor, { target: { value: "/he" } });
  fireEvent.click(screen.getByRole("option"));
  expect(editor.value).toBe("/help");
  expect(document.activeElement).toBe(editor);
  expect(submit).not.toHaveBeenCalled();
});

test("IME and Shift+Enter never accept a command; Escape dismisses before collapsing", () => {
  const submit = vi.fn();
  const { container } = render(<EditableComposer value="/" onSubmit={submit} />);
  const editor = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
  fireEvent.click(screen.getByRole("button", { name: "Expand message editor" }));
  fireEvent.keyDown(editor, { key: "Enter", isComposing: true });
  fireEvent.keyDown(editor, { key: "Enter", keyCode: 229 });
  fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
  expect(editor.value).toBe("/");
  expect(submit).not.toHaveBeenCalled();
  expect(screen.getByRole("listbox")).toBeTruthy();
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(container.querySelector(".composer-expanded")).not.toBeNull();
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(container.querySelector(".composer-expanded")).toBeNull();
});

test("unknown tokens stay editable and no-session drafts do not invent commands", () => {
  const submit = vi.fn();
  const { rerender } = render(<EditableComposer value="/unknown" onSubmit={submit} />);
  const editor = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
  fireEvent.focus(editor);
  expect(screen.queryByRole("option")).toBeNull();
  expect(screen.getByText("No matching commands")).toBeTruthy();
  fireEvent.keyDown(editor, { key: "Enter" });
  expect(submit).toHaveBeenCalledOnce();
  rerender(<EditableComposer commands={[]} draftMode historyReady={false} onSubmit={submit} />);
  fireEvent.change(editor, { target: { value: "/" } });
  expect(screen.getByText("Commands become available after your first message.")).toBeTruthy();
  expect(screen.queryByRole("option")).toBeNull();
  expect(submit).toHaveBeenCalledOnce();
});

test("live command replacement clears stale candidates and disabled editors hide the menu", () => {
  const { rerender } = render(<EditableComposer value="/" />);
  const editor = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
  fireEvent.focus(editor);
  fireEvent.keyDown(editor, { key: "ArrowDown" });
  rerender(<EditableComposer commands={[commands[0]!]} />);
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.getByRole("option").getAttribute("aria-selected")).toBe("true");
  rerender(<EditableComposer commands={[]} />);
  expect(screen.queryByRole("option")).toBeNull();
  rerender(<EditableComposer connected={false} />);
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("expanding and collapsing the editor preserves the draft and never submits", () => {
  const input = props();
  const { container } = render(<Composer {...input} />);
  const area = screen.getByRole<HTMLTextAreaElement>("combobox", {
    name: "Message",
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Expand message editor" }),
  );
  expect(container.querySelector(".composer-expanded")).not.toBeNull();
  expect(document.activeElement).toBe(area);
  expect(area.value).toBe(input.value);
  fireEvent.keyDown(area, { key: "Escape" });
  expect(container.querySelector(".composer-expanded")).toBeNull();
  expect(input.onSubmit).not.toHaveBeenCalled();
  expect(input.onChange).not.toHaveBeenCalled();
});

test("IME confirmation never submits or collapses the composer", () => {
  const input = props();
  const { container } = render(<Composer {...input} />);
  const area = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
  fireEvent.click(screen.getByRole("button", { name: "Expand message editor" }));
  fireEvent.keyDown(area, { key: "Enter", isComposing: true });
  fireEvent.keyDown(area, { key: "Enter", keyCode: 229 });
  fireEvent.keyDown(area, { key: "Escape", keyCode: 229 });
  expect(input.onSubmit).not.toHaveBeenCalled();
  expect(container.querySelector(".composer-expanded")).not.toBeNull();
  fireEvent.keyDown(area, { key: "Enter" });
  expect(input.onSubmit).toHaveBeenCalledOnce();
});

test("configuration, connection and execution gating survive toolbar integration", () => {
  const input = props();
  const { rerender } = render(<Composer {...input} configuring />);
  const area = screen.getByRole<HTMLTextAreaElement>("combobox", {
    name: "Message",
  });
  expect(area.disabled).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Send message" })
      .disabled,
  ).toBe(true);
  rerender(<Composer {...input} connected={false} />);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Attach files" })
      .disabled,
  ).toBe(true);
  rerender(<Composer {...input} sending cancellable />);
  expect(area.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Stop operation" }));
  expect(input.onCancel).toHaveBeenCalledOnce();
  expect(input.onSubmit).not.toHaveBeenCalled();
});

test("composer hint keeps one live region through availability changes", () => {
  const input = props();
  const { rerender } = render(<Composer {...input} />);
  const hint = screen.getByRole("status");
  const editor = screen.getByRole("combobox", { name: "Message" });
  expect(hint.textContent).toBe("");
  expect(editor.hasAttribute("aria-describedby")).toBe(false);

  rerender(<Composer {...input} connected={false} />);
  expect(screen.getByRole("status")).toBe(hint);
  expect(hint.textContent).toBe("Connection unavailable");
  expect(editor.getAttribute("aria-describedby")).toBe(hint.id);

  rerender(<Composer {...input} historyReady={false} />);
  expect(screen.getByRole("status")).toBe(hint);
  expect(hint.textContent).toBe("Conversation not yet synchronized");

  rerender(<Composer {...input} />);
  expect(screen.getByRole("status")).toBe(hint);
  expect(hint.textContent).toBe("");
  expect(editor.hasAttribute("aria-describedby")).toBe(false);
});

test("opening history keeps the draft mounted with an accurate disabled hint", () => {
  const input = props();
  const { rerender } = render(<Composer {...input} connected={false}
    historyReady={false} openingHistory />);
  const editor = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
  expect(editor.value).toBe("An unsent draft");
  expect(editor.disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toBe("Opening conversation history");
  rerender(<Composer {...input} connected={false} historyReady={false} openingFailure />);
  expect(screen.getByRole("status").textContent).toBe("Conversation history unavailable");
  expect(editor.value).toBe("An unsent draft");
});

test("unsynchronized history blocks a new message while an active Run can still be stopped", () => {
  const input = props();
  render(<Composer {...input} historyReady={false} cancellable />);
  expect(screen.getByText("Conversation not yet synchronized")).toBeTruthy();
  expect(screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Stop operation" }));
  expect(input.onCancel).toHaveBeenCalledOnce();
  expect(input.onSubmit).not.toHaveBeenCalled();
});

test("Agent draft accepts the first message without a Session View", () => {
  const input = props();
  render(<Composer {...input} historyReady={false} draftMode />);
  const editor = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
  expect(editor.disabled).toBe(false);
  expect(screen.queryByText("Conversation not yet synchronized")).toBeNull();
  fireEvent.keyDown(editor, { key: "Enter" });
  expect(input.onSubmit).toHaveBeenCalledOnce();
});

test("first send preparation reports creation without offering a fake Stop action", () => {
  render(<Composer {...props()} draftMode historyReady={false} sending preparing />);
  expect(screen.getByRole("status").textContent).toBe("Preparing conversation");
  expect(screen.queryByRole("button", { name: "Stop operation" })).toBeNull();
  expect(screen.getByRole("button", { name: "Preparing conversation" })).toBeTruthy();
});

test("uncertain Session creation retains editable text but pauses another send", () => {
  render(<Composer {...props()} draftMode historyReady={false} sendBlocked />);
  expect(screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" }).disabled).toBe(false);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send message" }).disabled).toBe(true);
});

test("Agent draft stays editable while disconnected but cannot send", () => {
  render(<Composer {...props()} draftMode historyReady={false} connected={false}
    agentStatus="unknown" />);
  expect(screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" }).disabled).toBe(false);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send message" }).disabled).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Attach files" }).disabled).toBe(true);
});

test("keyboard submission restores the editor only when focus was lost to the page", () => {
  const input = props();
  const { rerender } = render(<Composer {...input} />);
  const area = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
  area.focus();
  fireEvent.keyDown(area, { key: "Enter" });
  expect(input.onSubmit).toHaveBeenCalledOnce();
  rerender(<Composer {...input} sending />);
  document.body.tabIndex = -1;
  document.body.focus();
  expect(document.activeElement).toBe(document.body);
  rerender(<Composer {...input} />);
  expect(document.activeElement).toBe(area);

  fireEvent.keyDown(area, { key: "Enter" });
  rerender(<Composer {...input} sending />);
  const expand = screen.getByRole<HTMLButtonElement>("button", { name: "Expand message editor" });
  expand.focus();
  rerender(<Composer {...input} />);
  expect(document.activeElement).toBe(expand);

  area.focus();
  fireEvent.keyDown(area, { key: "Enter" });
  rerender(<Composer {...input} sending />);
  fireEvent.pointerDown(document.body);
  document.body.focus();
  rerender(<Composer {...input} />);
  expect(document.activeElement).toBe(document.body);
  document.body.removeAttribute("tabindex");
});

test("removing a focused attachment moves focus to the next attachment or editor", () => {
  const input = props();
  const first = { id: "first", name: "first.txt", kind: "file" as const, sizeLabel: "1 B" };
  const second = { id: "second", name: "second.txt", kind: "file" as const, sizeLabel: "1 B" };
  const { rerender } = render(<Composer {...input} attachments={[first, second]} />);
  const removeFirst = screen.getByRole<HTMLButtonElement>("button", { name: "Remove first.txt" });
  removeFirst.focus();
  fireEvent.click(removeFirst);
  rerender(<Composer {...input} attachments={[second]} />);
  const removeSecond = screen.getByRole<HTMLButtonElement>("button", { name: "Remove second.txt" });
  expect(document.activeElement).toBe(removeSecond);
  fireEvent.click(removeSecond);
  rerender(<Composer {...input} attachments={[]} />);
  expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Message" }));
});

test("removing the last attachment keeps focus on an available control when the editor is disabled", () => {
  const input = props();
  const attachment = { id: "draft", name: "draft.txt", kind: "file" as const, sizeLabel: "1 B" };
  const { rerender } = render(<Composer {...input} connected={false} attachments={[attachment]} />);
  const remove = screen.getByRole("button", { name: "Remove draft.txt" });
  remove.focus();
  fireEvent.click(remove);
  rerender(<Composer {...input} connected={false} attachments={[]} />);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Expand message editor" }));
});
