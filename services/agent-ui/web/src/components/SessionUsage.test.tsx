import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { SessionUsage } from "./SessionUsage";

afterEach(cleanup);

test("usage is absent until reported and keeps context separate from cumulative cost", () => {
  const view = render(<SessionUsage stale={false} />);
  expect(screen.queryByRole("group", { name: "Session usage" })).toBeNull();
  view.rerender(<SessionUsage usage={{ used: 100, size: 1000 }} stale={false} />);
  expect(screen.getByText("100 / 1,000")).toBeTruthy();
  expect(screen.getByText("Not reported")).toBeTruthy();
  expect(screen.getByText("May be incomplete")).toBeTruthy();
  expect(screen.queryByText("Last received")).toBeNull();
});

test("extreme amounts stay bounded with the exact received value available in the title", () => {
  const view = render(<SessionUsage usage={{ used: Number.MAX_SAFE_INTEGER, size: Number.MAX_SAFE_INTEGER, cost: { amount: Number.MIN_VALUE, currency: "USD" } }} stale />);
  expect(screen.getByTitle(`USD ${Number.MIN_VALUE}`).textContent?.length).toBeLessThan(40);
  expect(screen.getByText(`USD ${Number.MIN_VALUE}`)).toBeTruthy();
  expect(screen.getByText("Last received")).toBeTruthy();
  expect(screen.queryByText("USD 0")).toBeNull();
  view.rerender(<SessionUsage usage={{ used: 0, size: 1, cost: { amount: Number.MAX_VALUE, currency: "EUR" } }} stale={false} />);
  expect(screen.getByTitle(`EUR ${Number.MAX_VALUE}`).textContent?.length).toBeLessThan(40);
  expect(screen.getByText(`EUR ${Number.MAX_VALUE}`)).toBeTruthy();
  expect(screen.queryByText("Last received")).toBeNull();
});
