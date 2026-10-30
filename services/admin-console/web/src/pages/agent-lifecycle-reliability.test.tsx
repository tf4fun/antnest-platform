import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLifecycleReliability } from "../components/agent-lifecycle-reliability";
import { api, resetSessionRequests } from "../lib/api";
import type { Agent, LifecycleOperation } from "../lib/types";

vi.mock("../lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      cancelLifecycleOperation: vi.fn(),
      clearLifecycleQuarantine: vi.fn(),
    },
  };
});

const baseAgent: Agent = {
  agent_id: "agent-1",
  owner_user_id: "owner-1",
  name: "Agent",
  desired_state: "enabled",
  lifecycle_state: "created",
  activation_state: "enabled",
  runtime_state: "unknown",
  readiness: "preparing",
  aggregate_sequence: 7,
  agent_spec_revision: "spec-1",
  runtime: { runtime_revision: "rtv-1" },
  failure_code: "",
  failure_stage: "",
  created_at: "",
  updated_at: "",
};

const quarantined: Agent = {
  ...baseAgent,
  failure_code: "lifecycle_invariant_failed",
};

const runningCreate: LifecycleOperation = {
  request_id: "request-cancel-1",
  agent_id: "agent-1",
  kind: "create",
  phase: "network_ensure",
  state: "running",
  created_at: "",
  updated_at: "",
};

function mutationOwner() {
  return () => () => {};
}

function renderComponent(
  overrides: {
    agent?: Partial<Agent>;
    operation?: LifecycleOperation;
    blocked?: boolean;
    acquireMutation?: () => (() => void) | undefined;
    onOperation?: (op: LifecycleOperation) => void;
    onAgent?: (agent: Agent) => unknown;
    onRefresh?: () => Promise<Agent | undefined>;
  } = {},
) {
  const onOperation = overrides.onOperation ?? vi.fn();
  const onAgent = overrides.onAgent ?? vi.fn();
  const onRefresh = overrides.onRefresh ?? vi.fn().mockResolvedValue(undefined);
  const acquireMutation = overrides.acquireMutation ?? mutationOwner;
  const agent = { ...baseAgent, ...overrides.agent } as Agent;
  const view = render(
    <AgentLifecycleReliability
      agent={agent}
      operation={overrides.operation}
      blocked={overrides.blocked ?? false}
      acquireMutation={acquireMutation}
      onOperation={onOperation}
      onAgent={onAgent}
      onRefresh={onRefresh}
    />,
  );
  return { onOperation, onAgent, onRefresh, acquireMutation, view };
}

function panel() {
  return within(screen.getByTestId("lifecycle-reliability"));
}

describe("AgentLifecycleReliability", () => {
  beforeEach(() => {
    cleanup();
    vi.mocked(api.cancelLifecycleOperation).mockReset();
    vi.mocked(api.clearLifecycleQuarantine).mockReset();
  });

  it("shows cancel only for a known running operation on this Agent", () => {
    renderComponent({ operation: runningCreate });
    expect(
      panel().getByRole("button", { name: "Cancel operation" }),
    ).toBeTruthy();
  });

  it("offers no controls for terminal, foreign, or deleted-Agent operations", () => {
    for (const caseOp of [
      { ...runningCreate, state: "failed" as const },
      { ...runningCreate, agent_id: "agent-other" },
    ]) {
      const { container, unmount } = render(
        <AgentLifecycleReliability
          agent={baseAgent}
          operation={caseOp}
          blocked={false}
          acquireMutation={mutationOwner}
          onOperation={vi.fn()}
          onAgent={vi.fn()}
          onRefresh={vi.fn()}
        />,
      );
      expect(container.firstChild).toBeNull();
      unmount();
    }
    const { container } = render(
      <AgentLifecycleReliability
        agent={{ ...baseAgent, lifecycle_state: "deleted" }}
        operation={runningCreate}
        blocked={false}
        acquireMutation={mutationOwner}
        onOperation={vi.fn()}
        onAgent={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("confirms the exact original request and sends one POST per confirmation", async () => {
    vi.mocked(api.cancelLifecycleOperation).mockResolvedValue(runningCreate);
    const { onOperation } = renderComponent({ operation: runningCreate });
    fireEvent.click(panel().getByRole("button", { name: "Cancel operation" }));
    const confirm = within(screen.getByRole("dialog")).getByRole("button", {
      name: "Confirm cancel",
    });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.cancelLifecycleOperation).toHaveBeenCalledTimes(1),
    );
    expect(api.cancelLifecycleOperation).toHaveBeenCalledWith(
      "agent-1",
      "request-cancel-1",
      expect.anything(),
    );
    await waitFor(() =>
      expect(onOperation).toHaveBeenCalledWith(runningCreate),
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Cancellation requested",
    );
    expect(screen.getByRole("status").textContent).not.toContain("gone");
  });

  it("acknowledges a completed race without claiming cleanup or dispatching a delete", async () => {
    vi.mocked(api.cancelLifecycleOperation).mockResolvedValue({
      ...runningCreate,
      state: "completed",
      phase: "publish",
    });
    const { onOperation } = renderComponent({ operation: runningCreate });
    fireEvent.click(panel().getByRole("button", { name: "Cancel operation" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Confirm cancel",
      }),
    );
    await waitFor(() => expect(onOperation).toHaveBeenCalled());
    expect(screen.getByRole("status").textContent).toContain(
      "already completed",
    );
    expect(screen.getByRole("status").textContent).toContain(
      "no cancellation cleanup",
    );
  });

  it("rejects a mismatched cancellation receipt without callbacks", async () => {
    vi.mocked(api.cancelLifecycleOperation).mockResolvedValue({
      ...runningCreate,
      request_id: "request-other",
    });
    const { onOperation } = renderComponent({ operation: runningCreate });
    fireEvent.click(panel().getByRole("button", { name: "Cancel operation" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Confirm cancel",
      }),
    );
    await waitFor(() =>
      expect(api.cancelLifecycleOperation).toHaveBeenCalled(),
    );
    expect(onOperation).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).toContain("receipt"),
    );
    expect(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Confirm cancel",
      }),
    ).toHaveProperty("disabled", true);
  });

  it("posts the captured clear sequence once and keeps the Agent unknown", async () => {
    const cleared: Agent = {
      ...baseAgent,
      aggregate_sequence: 8,
      failure_code: "",
      failure_stage: "",
      runtime_state: "unknown",
      readiness: "preparing",
    };
    vi.mocked(api.clearLifecycleQuarantine).mockResolvedValue(cleared);
    const { onAgent } = renderComponent({
      agent: { failure_code: "lifecycle_invariant_failed" },
    });
    fireEvent.click(panel().getByRole("button", { name: "Clear quarantine" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Confirm clear",
      }),
    );
    await waitFor(() =>
      expect(api.clearLifecycleQuarantine).toHaveBeenCalledTimes(1),
    );
    expect(api.clearLifecycleQuarantine).toHaveBeenCalledWith(
      "agent-1",
      7,
      expect.anything(),
    );
    await waitFor(() => expect(onAgent).toHaveBeenCalledWith(cleared));
  });

  it("requires an explicit refresh after a 409 before a fresh confirmation", async () => {
    const { APIError } = await import("../lib/api");
    const conflict = new APIError(409, "lifecycle_conflict", "stale sequence");
    vi.mocked(api.clearLifecycleQuarantine).mockRejectedValueOnce(conflict);
    const cleared: Agent = {
      ...quarantined,
      aggregate_sequence: 10,
      failure_code: "",
      failure_stage: "",
    };
    const refreshed: Agent = { ...quarantined, aggregate_sequence: 9 };
    const onRefresh = vi.fn().mockResolvedValue(refreshed);
    const onAgent = vi.fn();
    const { view } = renderComponent({
      agent: { failure_code: "lifecycle_invariant_failed" },
      onRefresh,
      onAgent,
    });
    fireEvent.click(panel().getByRole("button", { name: "Clear quarantine" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Confirm clear",
      }),
    );
    await waitFor(() =>
      expect(api.clearLifecycleQuarantine).toHaveBeenCalledTimes(1),
    );
    expect(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Confirm clear",
      }),
    ).toHaveProperty("disabled", true);
    // Back retains the captured scope so the explicit refresh can still resolve it.
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Back" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.clearLifecycleQuarantine).toHaveBeenCalledTimes(1);
    fireEvent.click(panel().getByRole("button", { name: "Refresh Agent" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        panel().queryByRole("button", { name: "Refresh Agent" }),
      ).toBeNull(),
    );
    view.rerender(
      <AgentLifecycleReliability
        agent={refreshed}
        blocked={false}
        acquireMutation={mutationOwner}
        onOperation={vi.fn()}
        onAgent={onAgent}
        onRefresh={onRefresh}
      />,
    );
    vi.mocked(api.clearLifecycleQuarantine).mockResolvedValue(cleared);
    fireEvent.click(panel().getByRole("button", { name: "Clear quarantine" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Confirm clear",
      }),
    );
    await waitFor(() =>
      expect(api.clearLifecycleQuarantine).toHaveBeenCalledTimes(2),
    );
    expect(api.clearLifecycleQuarantine).toHaveBeenLastCalledWith(
      "agent-1",
      9,
      expect.anything(),
    );
    await waitFor(() => expect(onAgent).toHaveBeenCalledWith(cleared));
    expect(screen.getByRole("status").textContent).toContain(
      "Quarantine cleared",
    );
  });

  it("does not turn a failed post-accept refresh into a write failure", async () => {
    vi.mocked(api.cancelLifecycleOperation).mockResolvedValue(runningCreate);
    const onRefresh = vi.fn().mockRejectedValue(new Error("read down"));
    renderComponent({ operation: runningCreate, onRefresh });
    fireEvent.click(panel().getByRole("button", { name: "Cancel operation" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Confirm cancel",
      }),
    );
    await waitFor(() =>
      expect(api.cancelLifecycleOperation).toHaveBeenCalled(),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "Cancellation requested",
    );
  });

  it("ignores an in-flight response and releases once after the session changed", async () => {
    let releases = 0;
    let resolve: (value: LifecycleOperation) => void = () => {};
    vi.mocked(api.cancelLifecycleOperation).mockImplementation(
      () =>
        new Promise<LifecycleOperation>((done) => {
          resolve = done;
        }),
    );
    const { onOperation, onAgent, onRefresh } = renderComponent({
      operation: runningCreate,
      acquireMutation: () => () => {
        releases += 1;
      },
    });
    fireEvent.click(panel().getByRole("button", { name: "Cancel operation" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Confirm cancel",
      }),
    );
    await waitFor(() =>
      expect(api.cancelLifecycleOperation).toHaveBeenCalled(),
    );
    act(() =>
      resetSessionRequests({
        organization_id: "org-2",
        user_id: "admin-2",
        membership_id: "membership-2",
      }),
    );
    await act(async () => {
      resolve(runningCreate);
    });
    expect(onOperation).not.toHaveBeenCalled();
    expect(onAgent).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(releases).toBe(1);
  });

  it("never posts after the Agent changes between open and confirm", async () => {
    const { view } = renderComponent({ operation: runningCreate });
    fireEvent.click(panel().getByRole("button", { name: "Cancel operation" }));
    view.rerender(
      <AgentLifecycleReliability
        agent={{ ...baseAgent, agent_id: "agent-2" }}
        operation={{ ...runningCreate, agent_id: "agent-2" }}
        blocked={false}
        acquireMutation={mutationOwner}
        onOperation={vi.fn()}
        onAgent={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.cancelLifecycleOperation).not.toHaveBeenCalled();
  });

  it("aborts and releases exactly once when the Agent changes during a held command", async () => {
    let releases = 0;
    let signal: AbortSignal | undefined;
    let resolve: (value: LifecycleOperation) => void = () => {};
    vi.mocked(api.cancelLifecycleOperation).mockImplementation(
      (_id: string, _op: string, sig?: AbortSignal) =>
        new Promise<LifecycleOperation>((done) => {
          signal = sig;
          resolve = done;
        }),
    );
    const { onOperation, onRefresh, view } = renderComponent({
      operation: runningCreate,
      acquireMutation: () => () => {
        releases += 1;
      },
    });
    fireEvent.click(panel().getByRole("button", { name: "Cancel operation" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Confirm cancel",
      }),
    );
    await waitFor(() =>
      expect(api.cancelLifecycleOperation).toHaveBeenCalled(),
    );
    view.rerender(
      <AgentLifecycleReliability
        agent={{ ...baseAgent, agent_id: "agent-2" }}
        operation={{ ...runningCreate, agent_id: "agent-2" }}
        blocked={false}
        acquireMutation={() => () => {
          releases += 1;
        }}
        onOperation={onOperation}
        onAgent={vi.fn()}
        onRefresh={onRefresh}
      />,
    );
    await act(async () => {
      resolve(runningCreate);
    });
    expect(signal?.aborted).toBe(true);
    expect(releases).toBe(1);
    expect(onOperation).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("releases the mutex exactly once when unmounted mid-flight", async () => {
    let releases = 0;
    let resolve: (value: LifecycleOperation) => void = () => {};
    vi.mocked(api.cancelLifecycleOperation).mockImplementation(
      () =>
        new Promise<LifecycleOperation>((done) => {
          resolve = done;
        }),
    );
    const { view } = renderComponent({
      operation: runningCreate,
      acquireMutation: () => () => {
        releases += 1;
      },
    });
    fireEvent.click(panel().getByRole("button", { name: "Cancel operation" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Confirm cancel",
      }),
    );
    await waitFor(() =>
      expect(api.cancelLifecycleOperation).toHaveBeenCalled(),
    );
    view.unmount();
    await act(async () => {
      resolve(runningCreate);
    });
    expect(releases).toBe(1);
  });

  it("never posts after the running operation changes before confirm", async () => {
    const { view, onOperation } = renderComponent({ operation: runningCreate });
    fireEvent.click(panel().getByRole("button", { name: "Cancel operation" }));
    view.rerender(
      <AgentLifecycleReliability
        agent={baseAgent}
        operation={{
          ...runningCreate,
          request_id: "request-other",
          kind: "delete",
        }}
        blocked={false}
        acquireMutation={mutationOwner}
        onOperation={onOperation}
        onAgent={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Confirm cancel",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.cancelLifecycleOperation).not.toHaveBeenCalled();
    expect(onOperation).not.toHaveBeenCalled();
  });

  it("never posts after the captured sequence changes before confirm", async () => {
    const { view, onAgent } = renderComponent({
      agent: { failure_code: "lifecycle_invariant_failed" },
    });
    fireEvent.click(panel().getByRole("button", { name: "Clear quarantine" }));
    view.rerender(
      <AgentLifecycleReliability
        agent={{ ...quarantined, aggregate_sequence: 8 }}
        blocked={false}
        acquireMutation={mutationOwner}
        onOperation={vi.fn()}
        onAgent={onAgent}
        onRefresh={vi.fn()}
      />,
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Confirm clear",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.clearLifecycleQuarantine).not.toHaveBeenCalled();
    expect(onAgent).not.toHaveBeenCalled();
  });

  it("keeps Confirm disabled when blocked flips after the dialog opens", async () => {
    const { onAgent, view } = renderComponent({
      agent: { failure_code: "lifecycle_invariant_failed" },
    });
    fireEvent.click(panel().getByRole("button", { name: "Clear quarantine" }));
    expect(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Confirm clear",
      }),
    ).toHaveProperty("disabled", false);
    view.rerender(
      <AgentLifecycleReliability
        agent={quarantined}
        blocked={true}
        acquireMutation={mutationOwner}
        onOperation={vi.fn()}
        onAgent={onAgent}
        onRefresh={vi.fn()}
      />,
    );
    const confirm = within(screen.getByRole("dialog")).getByRole("button", {
      name: "Confirm clear",
    });
    expect(confirm).toHaveProperty("disabled", true);
    fireEvent.click(confirm);
    expect(api.clearLifecycleQuarantine).not.toHaveBeenCalled();
    expect(onAgent).not.toHaveBeenCalled();
  });

  it("never applies an old receipt when a different operation became active", async () => {
    vi.mocked(api.cancelLifecycleOperation).mockResolvedValue(runningCreate);
    const { onOperation, view } = renderComponent({ operation: runningCreate });
    fireEvent.click(panel().getByRole("button", { name: "Cancel operation" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Confirm cancel",
      }),
    );
    view.rerender(
      <AgentLifecycleReliability
        agent={{
          ...baseAgent,
          active_operation_request_id: "request-child-delete",
        }}
        operation={runningCreate}
        blocked={false}
        acquireMutation={mutationOwner}
        onOperation={onOperation}
        onAgent={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(api.cancelLifecycleOperation).toHaveBeenCalled(),
    );
    expect(onOperation).not.toHaveBeenCalled();
  });

  it("never posts when the parent mutex is unavailable", () => {
    renderComponent({
      operation: runningCreate,
      acquireMutation: () => undefined,
    });
    fireEvent.click(panel().getByRole("button", { name: "Cancel operation" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Confirm cancel",
      }),
    );
    expect(api.cancelLifecycleOperation).not.toHaveBeenCalled();
  });

  it("rejects a malformed clear receipt without applying it", async () => {
    for (const bad of [
      { ...baseAgent, aggregate_sequence: 8, readiness: "ready" as const },
      { ...baseAgent, aggregate_sequence: 7 },
      {
        ...baseAgent,
        aggregate_sequence: 8,
        failure_code: "lifecycle_invariant_failed",
      },
    ]) {
      vi.mocked(api.clearLifecycleQuarantine).mockResolvedValue(bad);
      const { onAgent } = renderComponent({
        agent: { failure_code: "lifecycle_invariant_failed" },
      });
      fireEvent.click(
        panel().getByRole("button", { name: "Clear quarantine" }),
      );
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Confirm clear",
        }),
      );
      await waitFor(() =>
        expect(api.clearLifecycleQuarantine).toHaveBeenCalled(),
      );
      expect(onAgent).not.toHaveBeenCalled();
      cleanup();
      vi.mocked(api.clearLifecycleQuarantine).mockReset();
    }
  });
});
