import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { ToolActivity } from "./ToolActivity";

const styles = readFileSync("src/styles.css", "utf8");

afterEach(cleanup);

test("Tool detail is collapsed initially and exposes complete literal multiline output", () => {
  const detail = `<script>not executable</script>\n${"long-token".repeat(2000)}\nFINAL_LINE`;
  const { container } = render(<>
    <style>{styles}</style>
    <ToolActivity activity={{ id: "tool", tool: "bash", label: "Run command", status: "completed", summary: "Completed", detail }} />
  </>);
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
