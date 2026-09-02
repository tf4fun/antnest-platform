import {
  ArrowLeft,
  Bot,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { DataTable, PageHeader, Section } from "../components/page";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { Empty, ErrorNotice, Loading } from "../components/ui/feedback";
import { Field, Input, Select } from "../components/ui/input";
import { api, errorMessage } from "../lib/api";
import { dateTime, shortID } from "../lib/format";
import type {
  Agent,
  AgentEvent,
  AgentTemplate,
  DirectoryMember,
  LifecycleOperation,
} from "../lib/types";

export function AgentsPage({ agentID }: { agentID?: string }) {
  return agentID ? <AgentDetail agentID={agentID} /> : <AgentInventory />;
}

function AgentInventory() {
  const [agents, setAgents] = useState<Agent[]>();
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [members, setMembers] = useState<DirectoryMember[]>([]);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    try {
      const overview = await api.overview();
      if (overview.agents.status !== "available")
        throw new Error("Agent inventory is unavailable.");
      setAgents(overview.agents.data.items);
      setTemplates(
        overview.templates.status === "available"
          ? overview.templates.data.items.filter((template) => template.enabled)
          : [],
      );
      setMembers(
        overview.directory.status === "available"
          ? overview.directory.data.users.filter(
              ({ user, membership }) => user.active && membership.active,
            )
          : [],
      );
      const unavailable = [overview.directory, overview.templates]
        .filter((section) => section.status === "unavailable")
        .map((section) => section.error.message);
      setError(
        unavailable.length > 0
          ? `Some creation options are unavailable: ${unavailable.join("; ")}`
          : "",
      );
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const selected = templates.find(
      (template) => template.template_id === data.get("template_id"),
    );
    if (!selected) {
      setError("Select an available template.");
      return;
    }
    setPending(true);
    setError("");
    try {
      const result = await api.createAgent({
        owner_user_id: String(data.get("owner_user_id") ?? ""),
        name: String(data.get("name") ?? "").trim(),
        template_id: selected.template_id,
        template_revision: selected.revision,
      });
      setOpen(false);
      window.location.hash = `agents/${result.agent.agent_id}`;
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  if (!agents && !error) return <Loading label="Loading Agents" />;
  return (
    <div className="grid gap-6">
      <PageHeader
        title="Agents"
        detail="Executable Agent inventory and current lifecycle state."
        actions={
          <Button
            disabled={templates.length === 0 || members.length === 0}
            onClick={() => setOpen(true)}
          >
            <Plus className="h-4 w-4" />
            Create Agent
          </Button>
        }
      />
      {error ? <ErrorNotice message={error} /> : null}
      {agents?.length === 0 ? (
        <Empty
          title="No Agents"
          detail={
            templates.length === 0
              ? "Create an Agent template first."
              : "Create the first Agent for a directory member."
          }
        />
      ) : (
        <DataTable>
          <table className="w-full min-w-[800px] text-left text-sm">
            <thead className="bg-muted/60 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Agent</th>
                <th className="px-3 py-2 font-medium">Lifecycle</th>
                <th className="px-3 py-2 font-medium">Desired state</th>
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="px-3 py-2 font-medium">Runtime</th>
                <th className="px-3 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {agents?.map((agent) => {
                const owner = members.find(
                  ({ user }) => user.id === agent.owner_user_id,
                )?.membership;
                return (
                  <tr
                    className="cursor-pointer hover:bg-muted/50"
                    key={agent.agent_id}
                    onClick={() => {
                      window.location.hash = `agents/${agent.agent_id}`;
                    }}
                  >
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-2">
                        <Bot className="h-4 w-4 text-muted-foreground" />
                        <div>
                          <p className="font-medium">{agent.name}</p>
                          <p className="font-mono text-xs text-muted-foreground">
                            {shortID(agent.agent_id)}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <Badge value={agent.lifecycle_state} />
                    </td>
                    <td className="px-3 py-3 capitalize">
                      {agent.desired_state}
                    </td>
                    <td className="px-3 py-3">
                      {owner?.display_name ?? shortID(agent.owner_user_id)}
                    </td>
                    <td className="px-3 py-3 font-mono text-xs text-muted-foreground">
                      {agent.runtime
                        ? shortID(agent.runtime.runtime_revision)
                        : "—"}
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {dateTime(agent.updated_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </DataTable>
      )}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Create Agent"
        description="Build an executable Agent from a template."
      >
        <form className="grid gap-4" onSubmit={submit}>
          <Field label="Name">
            <Input name="name" placeholder="Operations assistant" required />
          </Field>
          <Field label="Owner">
            <Select name="owner_user_id" defaultValue="" required>
              <option value="" disabled>
                Select a directory member
              </option>
              {members.map(({ user, membership }) => (
                <option value={user.id} key={user.id}>
                  {membership.display_name} · {membership.email}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Template">
            <Select name="template_id" defaultValue="" required>
              <option value="" disabled>
                Select a template
              </option>
              {templates.map((template) => (
                <option value={template.template_id} key={template.template_id}>
                  {template.name} · revision {template.revision}
                </option>
              ))}
            </Select>
          </Field>
          <div className="mt-2 flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button disabled={pending} type="submit">
              {pending ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : null}
              Create Agent
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

function AgentDetail({ agentID }: { agentID: string }) {
  const [agent, setAgent] = useState<Agent>();
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [streamCursor, setStreamCursor] = useState<number | null>(null);
  const latestSequence = useRef(0);
  const [streamGeneration, setStreamGeneration] = useState(0);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [operation, setOperation] = useState<LifecycleOperation>();
  const [streamState, setStreamState] = useState("connecting");
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");
  const [rebuildOpen, setRebuildOpen] = useState(false);

  const refreshAgent = useCallback(async () => {
    const next = await api.agent(agentID);
    setAgent(next);
    if (next.active_operation_request_id) {
      try {
        setOperation(await api.operation(next.active_operation_request_id));
      } catch {
        /* event stream remains authoritative */
      }
    }
    return next;
  }, [agentID]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.agent(agentID), api.events(agentID), api.templates()])
      .then(([nextAgent, page, templatePage]) => {
        if (cancelled) return;
        setAgent(nextAgent);
        setEvents(page.events);
        latestSequence.current = page.next_sequence;
        setStreamCursor(page.next_sequence);
        setTemplates(templatePage.items.filter((template) => template.enabled));
        if (nextAgent.active_operation_request_id) {
          void api
            .operation(nextAgent.active_operation_request_id)
            .then(setOperation)
            .catch(() => undefined);
        }
      })
      .catch((cause: unknown) => !cancelled && setError(errorMessage(cause)));
    return () => {
      cancelled = true;
    };
  }, [agentID]);

  useEffect(() => {
    if (streamCursor === null) return;
    const stream = new EventSource(api.eventStream(agentID, streamCursor));
    let reconnecting = false;
    let disposed = false;
    let retryTimer: number | undefined;
    stream.onopen = () => setStreamState("live");
    async function resync(): Promise<void> {
      try {
        const page = await api.events(agentID, latestSequence.current);
        if (disposed) return;
        setEvents((current) => {
          const known = new Set(current.map((item) => item.event_id));
          return [
            ...current,
            ...page.events.filter((item) => !known.has(item.event_id)),
          ];
        });
        latestSequence.current = page.next_sequence;
        setStreamCursor(page.next_sequence);
        setStreamGeneration((value) => value + 1);
      } catch (cause) {
        if (disposed) return;
        setError(errorMessage(cause));
        retryTimer = window.setTimeout(() => void resync(), 1000);
      }
    }
    stream.onerror = () => {
      if (reconnecting) return;
      reconnecting = true;
      stream.close();
      setStreamState("resyncing");
      void resync();
    };
    stream.addEventListener("agent_event", (message) => {
      try {
        const event = JSON.parse(
          (message as MessageEvent<string>).data,
        ) as AgentEvent;
        latestSequence.current = Math.max(
          latestSequence.current,
          event.global_sequence,
        );
        setEvents((current) =>
          current.some((item) => item.event_id === event.event_id)
            ? current
            : [...current, event],
        );
        void refreshAgent().catch((cause: unknown) =>
          setError(errorMessage(cause)),
        );
        if (event.operation_request_id) {
          void api
            .operation(event.operation_request_id)
            .then(setOperation)
            .catch(() => undefined);
        }
      } catch {
        setError("A lifecycle event could not be decoded.");
      }
    });
    return () => {
      disposed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      stream.close();
    };
  }, [agentID, refreshAgent, streamCursor, streamGeneration]);

  useEffect(() => {
    if (operation?.kind === "delete" && operation.state === "completed") {
      window.location.hash = "agents";
    }
  }, [operation]);

  async function act(
    action: "disable" | "enable" | "delete",
    payload: Record<string, unknown> = {},
  ) {
    if (
      action === "delete" &&
      !window.confirm(`Delete ${agent?.name ?? "this Agent"}?`)
    )
      return;
    setPending(action);
    setError("");
    try {
      setOperation(await api.lifecycle(agentID, action, payload));
      await refreshAgent();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending("");
    }
  }

  async function rebuild(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const template = templates.find(
      (item) => item.template_id === data.get("template_id"),
    );
    if (!template) return;
    setPending("rebuild");
    setError("");
    try {
      setOperation(
        await api.lifecycle(agentID, "rebuild", {
          template_id: template.template_id,
          template_revision: template.revision,
        }),
      );
      setRebuildOpen(false);
      await refreshAgent();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending("");
    }
  }

  if (error && !agent) return <ErrorNotice message={error} />;
  if (!agent) return <Loading label="Loading Agent" />;
  const busy =
    pending !== "" ||
    operation?.state === "running" ||
    Boolean(agent.active_operation_request_id);
  const canEnable =
    agent.desired_state === "disabled" || agent.lifecycle_state === "disabled";
  return (
    <div className="grid gap-7">
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            window.location.hash = "agents";
          }}
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Agents
        </Button>
      </div>
      <PageHeader
        title={agent.name}
        detail={`Agent ${agent.agent_id}`}
        actions={
          <>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setRebuildOpen(true)}
            >
              <RotateCcw className="h-4 w-4" />
              Rebuild
            </Button>
            {canEnable ? (
              <Button disabled={busy} onClick={() => void act("enable")}>
                <Play className="h-4 w-4" />
                Enable
              </Button>
            ) : (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void act("disable")}
              >
                <Pause className="h-4 w-4" />
                Disable
              </Button>
            )}
            <Button
              variant="destructive"
              size="icon"
              disabled={busy}
              aria-label="Delete Agent"
              onClick={() => void act("delete")}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </>
        }
      />
      {error ? <ErrorNotice message={error} /> : null}
      <div className="grid gap-px overflow-hidden rounded-md border border-border bg-border md:grid-cols-3">
        <Fact
          label="Lifecycle"
          value={<Badge value={agent.lifecycle_state} />}
        />
        <Fact
          label="Desired state"
          value={<span className="capitalize">{agent.desired_state}</span>}
        />
        <Fact
          label="Event stream"
          value={
            <span className="flex items-center gap-2 capitalize">
              <span
                className={`h-2 w-2 rounded-full ${streamState === "live" ? "bg-emerald-500" : "bg-amber-500"}`}
              />
              {streamState}
            </span>
          }
        />
        <Fact
          label="Runtime revision"
          value={
            <code>
              {agent.runtime
                ? shortID(agent.runtime.runtime_revision)
                : "Not assigned"}
            </code>
          }
        />
        <Fact
          label="Execution revision"
          value={
            <code>
              {agent.executable_execution_revision
                ? shortID(agent.executable_execution_revision)
                : "Not published"}
            </code>
          }
        />
        <Fact label="Updated" value={dateTime(agent.updated_at)} />
      </div>
      {operation ? (
        <Section title="Current operation">
          <div className="flex flex-wrap items-center gap-3 border-y border-border py-3 text-sm">
            <Badge value={operation.state} />
            <span className="font-medium capitalize">{operation.kind}</span>
            <span className="text-muted-foreground">
              {operation.phase.replaceAll("_", " ")}
            </span>
            {operation.error_detail ? (
              <span className="text-red-700">{operation.error_detail}</span>
            ) : null}
          </div>
        </Section>
      ) : null}
      <Section
        title="Lifecycle events"
        detail="Ordered evidence emitted by Agent Controller."
      >
        {events.length === 0 ? (
          <Empty
            title="No lifecycle events"
            detail="Events appear as the Agent changes state."
          />
        ) : (
          <div className="divide-y divide-border border-y border-border">
            {[...events].reverse().map((event) => (
              <div
                className="grid gap-1 py-3 sm:grid-cols-[minmax(180px,1fr)_auto]"
                key={event.event_id}
              >
                <div>
                  <p className="text-sm font-medium">
                    {event.event_type.replaceAll("_", " ")}
                  </p>
                  <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                    sequence {event.aggregate_sequence}
                    {event.trace_id
                      ? ` · trace ${shortID(event.trace_id)}`
                      : ""}
                  </p>
                </div>
                <time className="text-xs text-muted-foreground">
                  {dateTime(event.occurred_at)}
                </time>
              </div>
            ))}
          </div>
        )}
      </Section>
      <Dialog
        open={rebuildOpen}
        onOpenChange={setRebuildOpen}
        title="Rebuild Agent"
        description="Publish a new execution revision from the selected template."
      >
        <form className="grid gap-4" onSubmit={rebuild}>
          <Field label="Template">
            <Select name="template_id" defaultValue="" required>
              <option value="" disabled>
                Select a template revision
              </option>
              {templates.map((template) => (
                <option value={template.template_id} key={template.template_id}>
                  {template.name} · revision {template.revision}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setRebuildOpen(false)}
            >
              Cancel
            </Button>
            <Button disabled={pending === "rebuild"} type="submit">
              {pending === "rebuild" ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Rebuild
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="bg-background p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div className="mt-2 text-sm">{value}</div>
    </div>
  );
}
