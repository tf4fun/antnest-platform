import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { MessageView } from "./MessageView";
import { ToolActivity } from "./ToolActivity";

afterEach(cleanup);
const styles = readFileSync("src/styles.css", "utf8");

test("Thinking shares the tool card frame and header metrics", () => {
  const { container } = render(
    <>
      <style>{styles}</style>
      <MessageView
        message={{
          id: "thought",
          role: "assistant",
          presentation: "thought",
          content: "Compare the source notes.",
        }}
      />
      <ToolActivity
        activity={{
          id: "read",
          tool: "read",
          label: "Read notes",
          status: "completed",
          summary: "Completed",
          output: "Source notes",
        }}
      />
    </>,
  );
  const thought =
    container.querySelector<HTMLDetailsElement>(".thought-process")!;
  const tool = container.querySelector<HTMLDetailsElement>(".tool-activity")!;
  expect(thought.open).toBe(false);
  for (const property of [
    "borderTopStyle",
    "borderTopWidth",
    "borderRadius",
    "backgroundColor",
  ] as const) {
    expect(getComputedStyle(thought)[property]).toBe(
      getComputedStyle(tool)[property],
    );
  }
  for (const property of ["minHeight", "padding", "gap"] as const) {
    expect(getComputedStyle(thought.querySelector("summary")!)[property]).toBe(
      getComputedStyle(tool.querySelector("summary")!)[property],
    );
  }
  fireEvent.click(thought.querySelector("summary")!);
  const body = thought.querySelector(".message-content")!;
  // Browser coverage checks the separator; jsdom cannot resolve its CSS variable.
  expect(getComputedStyle(body).padding).toBe("12px");
  expect(getComputedStyle(body).marginLeft).toBe("0px");
});

test("streaming Thinking preserves manual disclosure and remains separate from the reply", () => {
  const onDisclosure = vi.fn();
  const message = {
    id: "thought",
    role: "assistant" as const,
    presentation: "thought" as const,
    content: "Compare **numbers**",
  };
  const { container, rerender } = render(
    <MessageView message={message} onDisclosure={onDisclosure} />,
  );
  const thought = container.querySelector<HTMLDetailsElement>("details")!;
  fireEvent.click(thought.querySelector("summary")!);
  expect(onDisclosure).toHaveBeenCalledOnce();
  rerender(
    <MessageView
      message={{ ...message, content: message.content + " and source notes." }}
      onDisclosure={onDisclosure}
    />,
  );
  expect(container.querySelector("details")).toBe(thought);
  expect(thought.open).toBe(true);
  expect(screen.getByText("numbers").tagName).toBe("STRONG");
  expect(screen.queryByRole("button", { name: "Copy response" })).toBeNull();
});
