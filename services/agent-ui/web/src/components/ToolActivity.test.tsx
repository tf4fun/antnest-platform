import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ToolActivity } from "./ToolActivity";

const styles = readFileSync("src/styles.css", "utf8");

afterEach(cleanup);

test("Tool detail is collapsed initially and exposes complete literal multiline output", () => {
  const detail = `<script>not executable</script>\n${"long-token".repeat(2000)}\nFINAL_LINE`;
  const { container } = render(
    <>
      <style>{styles}</style>
      <ToolActivity
        activity={{
          id: "tool",
          tool: "bash",
          label: "Run command",
          status: "completed",
          summary: "Completed",
          detail,
        }}
      />
    </>,
  );
  const disclosure = container.querySelector("details")!;
  expect(disclosure.open).toBe(false);
  fireEvent.click(container.querySelector("summary")!);
  expect(disclosure.open).toBe(true);
  const output = container.querySelector("pre")!;
  expect(output).not.toBeNull();
  expect(output.textContent).toBe(detail);
  expect(container.querySelector("script")).toBeNull();
  const style = getComputedStyle(output);
  expect(style.whiteSpace).toBe("pre-wrap");
  expect(style.overflowWrap).toBe("anywhere");
  expect(style.overflowY).toBe("auto");
});

test("tool payloads have independent copy controls and remain literal and expanded", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const input = '{"path":"/workspace/report.md"}';
  const output = "<b>not HTML</b>\nFINAL_LINE";
  const { container, rerender } = render(
    <ToolActivity
      activity={{
        id: "read",
        tool: "read",
        label: "Read report",
        status: "completed",
        summary: "Completed",
        input,
        output,
      }}
    />,
  );
  const detail = container.querySelector("details")!;
  fireEvent.click(container.querySelector("summary")!);
  expect(screen.getByRole("region", { name: "Input" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Output" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy input" }));
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(input));
  fireEvent.click(screen.getByRole("button", { name: "Copy output" }));
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(output));
  expect(detail.open).toBe(true);
  expect(container.querySelector("b")).toBeNull();
  rerender(
    <ToolActivity
      activity={{
        id: "read",
        tool: "read",
        label: "Read report",
        status: "completed",
        summary: "Completed",
        input,
        output: "Updated output",
      }}
    />,
  );
  expect(detail.open).toBe(true);
  expect(screen.getByRole("button", { name: "Copy output" }).title).toBe(
    "Copy output",
  );
});

test.each([
  ["running", "Waiting for output"],
  ["failed", "No output received"],
  ["completed", "No output received"],
] as const)("%s tool without output has a readable body", (status, message) => {
  const { container } = render(
    <ToolActivity
      activity={{
        id: "bash",
        tool: "bash",
        label: "Run command",
        status,
        summary: status,
      }}
    />,
  );
  fireEvent.click(container.querySelector("summary")!);
  expect(screen.getByText(message)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Copy output" })).toBeNull();
});
