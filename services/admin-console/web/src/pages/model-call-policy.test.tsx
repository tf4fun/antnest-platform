import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelCallPolicyPage } from "./model-call-policy";

const PRINCIPAL: [string, string] = ["org-1", "user-1"];
const PATH = "/api/admin/model-call-policy";

const policy = (revision: number, extras: Record<string, unknown> = {}) => ({
  revision,
  unknown_cost: "allow",
  run_caps: {},
  daily: {},
  monthly: {},
  ...extras,
});

type Call = { init: RequestInit; body?: Record<string, unknown> };

function stub(policyBody: Record<string, unknown>, puts: { status: number; body?: unknown }[] = []) {
  const calls: Call[] = [];
  const queue = [...puts];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://localhost");
    if (url.pathname !== PATH) throw new Error(`unexpected ${url.pathname}`);
    if ((init.method ?? "GET") === "GET") {
      calls.push({ init });
      return Response.json(policyBody);
    }
    calls.push({ init, body: JSON.parse(String(init.body)) });
    const next = queue.shift() ?? { status: 200, body: policyBody };
    return next.status >= 300 && next.body === undefined
      ? new Response("unavailable", { status: next.status })
      : Response.json(next.body, { status: next.status });
  }));
  return calls;
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

async function openPage(body = policy(3)) {
  const calls = stub(body);
  render(<ModelCallPolicyPage expectedPrincipal={PRINCIPAL} />);
  await screen.findByText("Save budget");
  return calls;
}

describe("ModelCallPolicyPage", () => {
  it("submits the exact revision, principal and zero caps", async () => {
    const calls = stub(policy(3), [{ status: 200, body: policy(4, { run_caps: { max_input_tokens: 0, max_cost_usd_micros: 1 } }) }]);
    render(<ModelCallPolicyPage expectedPrincipal={PRINCIPAL} />);
    await screen.findByText("Save budget");
    fireEvent.change(screen.getByLabelText(/Input token limit/), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText(/Cost limit per run/), { target: { value: "0.000001" } });
    fireEvent.click(screen.getByText("Save budget"));
    await waitFor(() => expect(calls.some((c) => c.init.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.init.method === "PUT")!;
    expect(put.body).toMatchObject({
      expected_revision: 3,
      expected_principal: ["org-1", "user-1"],
      run_caps: { max_input_tokens: 0, max_cost_usd_micros: 1 },
    });
    await screen.findByText(/revision 4/);
  });

  it("blocks inverted soft and hard caps without a write", async () => {
    const calls = await openPage();
    fireEvent.change(screen.getByLabelText(/^Soft limit/i, { selector: '[name="daily_soft_usd"]' }), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText(/^Hard limit/i, { selector: '[name="daily_hard_usd"]' }), { target: { value: "5" } });
    fireEvent.click(screen.getByText("Save budget"));
    await screen.findByRole("alert");
    expect(calls.filter((c) => c.init.method === "PUT")).toHaveLength(0);
  });

  it("blocks an inverted monthly soft cap without a write", async () => {
    const calls = await openPage();
    fireEvent.change(screen.getByLabelText(/^Soft limit/i, { selector: '[name="monthly_soft_usd"]' }), { target: { value: "9" } });
    fireEvent.change(screen.getByLabelText(/^Hard limit/i, { selector: '[name="monthly_hard_usd"]' }), { target: { value: "4" } });
    fireEvent.click(screen.getByText("Save budget"));
    await screen.findByRole("alert");
    expect(calls.filter((c) => c.init.method === "PUT")).toHaveLength(0);
  });

  it("rejects a malformed nonblank cap instead of widening it", async () => {
    const calls = await openPage();
    fireEvent.change(screen.getByLabelText(/Cost limit per run/), { target: { value: "abc" } });
    fireEvent.click(screen.getByText("Save budget"));
    await screen.findByRole("alert");
    expect(calls.filter((c) => c.init.method === "PUT")).toHaveLength(0);
  });

  it("preserves explicit zero and blank monthly caps exactly", async () => {
    const calls = stub(policy(3), [{
      status: 200,
      body: policy(4, { monthly: { soft_cost_usd_micros: 0 } }),
    }]);
    render(<ModelCallPolicyPage expectedPrincipal={PRINCIPAL} />);
    await screen.findByText("Save budget");
    fireEvent.change(screen.getByLabelText(/^Soft limit/i, { selector: '[name="monthly_soft_usd"]' }), { target: { value: "0" } });
    fireEvent.click(screen.getByText("Save budget"));
    await waitFor(() => expect(calls.some((c) => c.init.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.init.method === "PUT")!.body).toMatchObject({
      monthly: { soft_cost_usd_micros: 0 },
    });
    expect(calls.find((c) => c.init.method === "PUT")!.body!.monthly).not.toHaveProperty("hard_cost_usd_micros");
  });

  it("retries a transient failure with the same body and idempotency key", async () => {
    const calls = stub(policy(3), [
      { status: 503 },
      { status: 200, body: policy(4) },
    ]);
    render(<ModelCallPolicyPage expectedPrincipal={PRINCIPAL} />);
    await screen.findByText("Save budget");
    fireEvent.click(screen.getByText("Save budget"));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByText("Save budget"));
    await screen.findByText(/revision 4/);
    const puts = calls.filter((c) => c.init.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts[0]!.init.headers).toEqual(puts[1]!.init.headers);
    expect(puts[0]!.body).toEqual(puts[1]!.body);
  });

  it("keeps the request key after a malformed acknowledgement", async () => {
    const calls = stub(policy(3), [
      { status: 200, body: policy(9, { run_caps: { bogus: 1 } }) },
      { status: 200, body: policy(4) },
    ]);
    render(<ModelCallPolicyPage expectedPrincipal={PRINCIPAL} />);
    await screen.findByText("Save budget");
    fireEvent.click(screen.getByText("Save budget"));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByText("Save budget"));
    await screen.findByText(/revision 4/);
    const puts = calls.filter((c) => c.init.method === "PUT");
    expect(puts[0]!.init.headers).toEqual(puts[1]!.init.headers);
  });

  it("locks saving on a conflict until the policy is reloaded", async () => {
    const calls = stub(policy(3), [{ status: 409, body: { code: "resource_version_conflict" } }]);
    render(<ModelCallPolicyPage expectedPrincipal={PRINCIPAL} />);
    await screen.findByText("Save budget");
    fireEvent.change(screen.getByLabelText(/Input token limit/), { target: { value: "50" } });
    fireEvent.click(screen.getByText("Save budget"));
    await screen.findByRole("alert");
    expect((screen.getByText("Save budget") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(/Input token limit/) as HTMLInputElement).value).toBe("50");
    fireEvent.click(screen.getByText("Reload policy"));
    await waitFor(() => expect((screen.getByText("Save budget") as HTMLButtonElement).disabled).toBe(false));
  });

  it("reloads the fresh revision after a conflict and saves against it", async () => {
    let gets = 0;
    const calls: Call[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, "http://localhost");
      if (url.pathname !== PATH) throw new Error(`unexpected ${url.pathname}`);
      if ((init.method ?? "GET") === "GET") {
        gets += 1;
        calls.push({ init });
        return Response.json(gets === 1 ? policy(3) : policy(5, { run_caps: { max_input_tokens: 7 } }));
      }
      calls.push({ init, body: JSON.parse(String(init.body)) });
      const puts = calls.filter((c) => c.init.method === "PUT").length;
      return puts === 1
        ? Response.json({ code: "resource_version_conflict", message: "stale" }, { status: 409 })
        : Response.json(policy(6, { run_caps: { max_input_tokens: 7 } }));
    }));
    render(<ModelCallPolicyPage expectedPrincipal={PRINCIPAL} />);
    await screen.findByText("Save budget");
    fireEvent.change(screen.getByLabelText(/Input token limit/), { target: { value: "50" } });
    fireEvent.click(screen.getByText("Save budget"));
    await screen.findByRole("alert");
    expect((screen.getByLabelText(/Input token limit/) as HTMLInputElement).value).toBe("50");
    fireEvent.click(screen.getByText("Reload policy"));
    await waitFor(() => expect((screen.getByLabelText(/Input token limit/) as HTMLInputElement).value).toBe("7"));
    fireEvent.click(screen.getByText("Save budget"));
    await waitFor(() => expect(calls.filter((c) => c.init.method === "PUT")).toHaveLength(2));
    expect(calls.filter((c) => c.init.method === "PUT")[1]!.body).toMatchObject({ expected_revision: 5 });
    await screen.findByText(/revision 6/);
  });

  it("shows a terminal failure without retry when the save is forbidden", async () => {
    const calls = stub(policy(3), [{ status: 403, body: { code: "forbidden", message: "denied" } }]);
    render(<ModelCallPolicyPage expectedPrincipal={PRINCIPAL} />);
    await screen.findByText("Save budget");
    fireEvent.click(screen.getByText("Save budget"));
    await screen.findByText(/denied|forbidden|Organization budget/i);
    expect(screen.queryByText("Save budget")).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    expect(calls.filter((c) => c.init.method === "PUT")).toHaveLength(1);
  });

  it("treats an unauthenticated read as terminal without retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "service_unauthenticated", message: "expired" }, { status: 401 })));
    render(<ModelCallPolicyPage expectedPrincipal={PRINCIPAL} />);
    await screen.findByText(/expired|forbidden|Organization budget/i);
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("shows a terminal failure without retry on forbidden", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "forbidden", message: "denied" }, { status: 403 })));
    render(<ModelCallPolicyPage expectedPrincipal={PRINCIPAL} />);
    await screen.findByText(/denied|forbidden|budget/i);
    expect(screen.queryByText("Save budget")).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("ignores a late read after unmount", async () => {
    let resolve: (value: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(async () => new Promise<Response>((done) => { resolve = done; })));
    const view = render(<ModelCallPolicyPage expectedPrincipal={PRINCIPAL} />);
    view.unmount();
    resolve(Response.json(policy(3)));
    await Promise.resolve();
  });

  it("ignores the previous scope's late read and saves under the new principal", async () => {
    const calls: Call[] = [];
    const pending: { method: string; resolve: (response: Response) => void }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, "http://localhost");
      if (url.pathname !== PATH) throw new Error(`unexpected ${url.pathname}`);
      const method = init.method ?? "GET";
      if (method === "GET") {
        calls.push({ init });
        return await new Promise<Response>((resolve) => pending.push({ method, resolve }));
      }
      calls.push({ init, body: JSON.parse(String(init.body)) });
      return Response.json(policy(9));
    }));
    const view = render(<ModelCallPolicyPage expectedPrincipal={["org-old", "user-old"]} />);
    // Replace the scope before the first read answers; the stale result must
    // be dropped even though this is the same mounted component.
    view.rerender(<ModelCallPolicyPage expectedPrincipal={["org-new", "user-new"]} />);
    pending.find((entry) => entry.method === "GET")!.resolve(Response.json(policy(3)));
    const later = pending.filter((entry) => entry.method === "GET")[1]!;
    later.resolve(Response.json(policy(7)));
    await screen.findByText("Save budget");
    fireEvent.click(screen.getByText("Save budget"));
    await waitFor(() => expect(calls.some((c) => c.init.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.init.method === "PUT")!.body).toMatchObject({
      expected_revision: 7,
      expected_principal: ["org-new", "user-new"],
    });
  });

  it("unlocks and ignores a superseded save when the scope changes", async () => {
    let getCount = 0;
    let resolvePut: (response: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, "http://localhost");
      if (url.pathname !== PATH) throw new Error(`unexpected ${url.pathname}`);
      if ((init.method ?? "GET") === "GET") {
        getCount += 1;
        return Response.json(getCount === 1 ? policy(3) : policy(7));
      }
      return await new Promise<Response>((resolve) => { resolvePut = resolve; });
    }));
    const view = render(<ModelCallPolicyPage expectedPrincipal={["org-old", "user-old"]} />);
    await screen.findByText("Save budget");
    fireEvent.click(screen.getByText("Save budget"));
    // Pending switches the label and disables the button while the PUT is in flight.
    await screen.findByRole("button", { name: "Saving…" });
    // The scope changes while the PUT is still in flight: the new load must
    // clear the pending lock even though the old save never resolves in time.
    view.rerender(<ModelCallPolicyPage expectedPrincipal={["org-new", "user-new"]} />);
    await screen.findByText(/Revision 7/);
    await waitFor(() => expect((screen.getByText("Save budget") as HTMLButtonElement).disabled).toBe(false));
    resolvePut(Response.json(policy(4)));
    await Promise.resolve();
    expect(screen.getByText(/Revision 7/)).toBeTruthy();
    expect(screen.queryByText(/revision 4/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
