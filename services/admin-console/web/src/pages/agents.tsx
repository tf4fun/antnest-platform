import { AgentNetworkPolicy } from "../components/agent-network-policy";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Bot,
  CircleDot,
  ClipboardList,
  LoaderCircle,
  MessageSquareText,
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
import {
  DataTable,
  ListPagination,
  MobileResourceItem,
  MobileResourceList,
  PageHeader,
  ResourceFailureNotice,
  ResourceFailurePage,
  ResourceToolbar,
  SearchField,
  Section,
} from "../components/page";
import { Badge } from "../components/ui/badge";
import { agentWorkspacePath } from "../lib/session-destination";
import { ManagedMCPSummary } from "../components/managed-mcp";
import { ModelRates } from "../components/model-pricing";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { Empty, ErrorNotice, GuidanceNotice, Loading, SuccessNotice } from "../components/ui/feedback";
import { Field, Input, Select } from "../components/ui/input";
import {
  agentActionAvailability,
  agentEventLabel,
  agentFailureMessage,
  agentRecoveryAvailable,
  agentOwnerView,
  agentStatusPresentation,
  agentsForView,
  mergeAgentEvents,
  reconcileAgentOperation,
  selectAgentSnapshot,
  selectOperationSnapshot,
  type AgentFleetView,
} from "../lib/agent-fleet";
import {
  agentDetailFailure,
  agentEventRecoveryDecision,
} from "../lib/agent-detail-resources";
import { agentConfigurationLinks, agentConfigurationSummary } from "../lib/agent-configuration";
import { api, errorMessage } from "../lib/api";
import { useTemplateOptions } from "../lib/catalog-options";
import { dateTime } from "../lib/format";
import { modelInputLabel } from "../lib/model-catalog";
import { mergePage } from "../lib/pagination";
import { resourceFailure, type ResourceFailure } from "../lib/resource-failure";
import { agentCreationGate } from "../lib/setup";
import type {
  Agent,
  AgentEvent,
  DirectoryMember,
  LifecycleOperation,
} from "../lib/types";

export function AgentsPage({ agentID, networkScope }: { agentID?: string; networkScope?: string }) {
  return agentID ? <AgentDetail agentID={agentID} networkScope={networkScope} key={JSON.stringify([agentID, networkScope])} /> : <AgentInventory />;
}

function AgentInventory() {
  const [agents, setAgents] = useState<Agent[]>();
  const [agentsIncludingDeleted, setAgentsIncludingDeleted] = useState<Agent[]>();
  const {
    items: templates,
    available: templatesAvailable,
    hasMore: templatesHaveMore,
    pending: templatesPending,
    failure: templateOptionFailure,
    loadInitial: loadTemplates,
    loadMore: loadMoreTemplates,
    retry: retryTemplates,
  } = useTemplateOptions();
  const [members, setMembers] = useState<DirectoryMember[]>([]);
  const [directoryAvailable, setDirectoryAvailable] = useState<boolean>();
  const [inventoryFailure, setInventoryFailure] = useState<ResourceFailure>();
  const [directoryFailure, setDirectoryFailure] = useState<ResourceFailure>();
  const [formError, setFormError] = useState("");
  const [deletedFailure, setDeletedFailure] = useState<ResourceFailure>();
  const [deletedLoading, setDeletedLoading] = useState(false);
  const [nextCursors, setNextCursors] = useState<Record<AgentFleetView, string | undefined>>({
    current: undefined,
    deleted: undefined,
  });
  const [pageFailures, setPageFailures] = useState<Record<AgentFleetView, ResourceFailure | undefined>>({
    current: undefined,
    deleted: undefined,
  });
  const [pagePending, setPagePending] = useState<Record<AgentFleetView, boolean>>({
    current: false,
    deleted: false,
  });
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<AgentFleetView>("current");

  const loadAgents = useCallback(async () => {
    setInventoryFailure(undefined);
    setPageFailures((current) => ({ ...current, current: undefined }));
    try {
      const page = await api.agents({ view: "current" });
      setAgents(page.items);
      setNextCursors((current) => ({ ...current, current: page.next_cursor ?? undefined }));
    } catch (cause) {
      setInventoryFailure(resourceFailure(cause));
    }
  }, []);
  const loadDirectory = useCallback(async () => {
    setDirectoryFailure(undefined);
    try {
      const directory = await api.directory();
      setMembers(directory.users);
      setDirectoryAvailable(true);
    } catch (cause) {
      setDirectoryAvailable((current) => current ?? false);
      setDirectoryFailure(resourceFailure(cause));
    }
  }, []);
  useEffect(() => {
    void loadAgents();
    void loadDirectory();
    void loadTemplates();
  }, [loadAgents, loadDirectory, loadTemplates]);

  const loadDeleted = useCallback(async () => {
    setDeletedLoading(true);
    setDeletedFailure(undefined);
    setPageFailures((current) => ({ ...current, deleted: undefined }));
    try {
      const page = await api.agents({ view: "deleted" });
      setAgentsIncludingDeleted(page.items);
      setNextCursors((current) => ({ ...current, deleted: page.next_cursor ?? undefined }));
    } catch (cause) {
      setDeletedFailure(resourceFailure(cause));
    } finally {
      setDeletedLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view === "deleted" && agentsIncludingDeleted === undefined && !deletedLoading && !deletedFailure) {
      void loadDeleted();
    }
  }, [agentsIncludingDeleted, deletedFailure, deletedLoading, loadDeleted, view]);

  async function loadMore(target: AgentFleetView) {
    const cursor = nextCursors[target];
    if (!cursor || pagePending[target] || pageFailures[target]?.retryable === false) return;
    setPagePending((current) => ({ ...current, [target]: true }));
    setPageFailures((current) => ({ ...current, [target]: undefined }));
    try {
      const page = await api.agents({ view: target, cursor });
      if (target === "current") {
        setAgents((current) => mergePage(current ?? [], page.items, (item) => item.agent_id));
      } else {
        setAgentsIncludingDeleted((current) =>
          mergePage(current ?? [], page.items, (item) => item.agent_id));
      }
      setNextCursors((current) => ({ ...current, [target]: page.next_cursor ?? undefined }));
    } catch (cause) {
      setPageFailures((current) => ({ ...current, [target]: resourceFailure(cause) }));
    } finally {
      setPagePending((current) => ({ ...current, [target]: false }));
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const selected = templates.find(
      (template) => template.template_id === data.get("template_id"),
    );
    if (!selected) {
      setFormError("Select an available template.");
      return;
    }
    setPending(true);
    setFormError("");
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
      setFormError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  if (!agents) {
    if (!inventoryFailure) return <Loading label="Loading Agents" />;
    return (
      <ResourceFailurePage
        eyebrow="Fleet"
        failure={inventoryFailure}
        resource="Agent inventory"
        returnHref="#overview"
        returnLabel="Back to Overview"
        onRetry={() => void loadAgents()}
      />
    );
  }
  const owners = agentOwnerView(members);
  const creationGate = agentCreationGate({
    templatesAvailable,
    templatesRetryable: templateOptionFailure?.retryable,
    templateCount: templates.length,
    templatesHaveMore,
    directoryAvailable,
    directoryRetryable: directoryFailure?.retryable,
    memberCount: owners.selectable.length,
  });
  const visibleAgents = agentsForView(
    view === "deleted" ? agentsIncludingDeleted ?? [] : agents ?? [],
    view,
  );
  const normalized = query.trim().toLowerCase();
  const filtered = visibleAgents.filter((agent) => {
    const owner = owners.byUserID.get(agent.owner_user_id)?.membership;
    return [agent.name, agent.agent_id, owner?.display_name ?? "", owner?.email ?? ""]
      .some((value) => value.toLowerCase().includes(normalized));
  });
  return (
    <div className="grid gap-5">
      <PageHeader
        eyebrow="Fleet"
        title="Agents"
        detail="Executable Agent inventory, ownership, and lifecycle state."
        actions={
          <Button
            disabled={!creationGate.allowed}
            title={creationGate.message}
            onClick={() => { setFormError(""); setOpen(true); }}
          >
            <Plus className="h-4 w-4" />
            Create Agent
          </Button>
        }
      />
      {inventoryFailure ? <ResourceFailureNotice failure={inventoryFailure} retryLabel="Retry Agent inventory" onRetry={() => void loadAgents()} /> : null}
      {templateOptionFailure ? <ResourceFailureNotice failure={templateOptionFailure} message={`Template choices could not be loaded: ${templateOptionFailure.message}`} retryLabel="Retry template choices" onRetry={retryTemplates} /> : null}
      {directoryFailure ? <ResourceFailureNotice failure={directoryFailure} message={`Directory choices could not be loaded: ${directoryFailure.message}`} retryLabel="Retry directory" onRetry={() => void loadDirectory()} /> : null}
      {!creationGate.allowed && view === "current" && visibleAgents.length > 0 ? (
        <GuidanceNotice
          message={creationGate.message ?? "Complete the required configuration first."}
          action={creationGate.href
            ? <Button asChild size="sm" variant="secondary"><a href={creationGate.href}>{creationGate.action}</a></Button>
            : undefined}
        />
      ) : null}
      {view === "deleted" && deletedFailure ? <ResourceFailureNotice failure={deletedFailure} retryLabel="Retry deleted records" onRetry={() => void loadDeleted()} /> : null}
      <ResourceToolbar>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div
            aria-label="Agent inventory view"
            className="inline-flex w-fit rounded-md border border-border bg-white p-1 shadow-xs"
            role="tablist"
          >
            {(["current", "deleted"] as const).map((item) => (
              <button
                aria-selected={view === item}
                className={`flex h-8 items-center gap-2 rounded-sm px-3 text-xs font-medium transition-colors ${
                  view === item
                    ? "bg-[#1d1d1b] text-white"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
                key={item}
                role="tab"
                type="button"
                onClick={() => setView(item)}
              >
                {item === "deleted" ? <Archive className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
                {item === "deleted" ? "Deleted" : "Current"}
              </button>
            ))}
          </div>
          <SearchField value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Agents or owners" />
        </div>
        <p className="text-sm text-muted-foreground">
          {filtered.length} matching · {visibleAgents.length} loaded
          {nextCursors[view] ? " · More available" : ""}
        </p>
      </ResourceToolbar>
      {view === "current" && agents === undefined ? null :
      view === "deleted" && deletedFailure && agentsIncludingDeleted === undefined ? null :
      deletedLoading && view === "deleted" ? (
        <Loading label="Loading deleted Agents" />
      ) : visibleAgents.length === 0 ? (
        <Empty
          title={view === "deleted" ? "No deleted Agents" : "No Agents"}
          detail={
            view === "deleted"
              ? "Deleted Agent records retained for audit appear here."
              : creationGate.message ?? "Create the first Agent for a directory member."
          }
          action={view === "current"
            ? creationGate.allowed
              ? <Button size="sm" onClick={() => { setFormError(""); setOpen(true); }}><Plus className="h-4 w-4" />Create Agent</Button>
              : creationGate.href
              ? <Button asChild size="sm" variant="secondary"><a href={creationGate.href}>{creationGate.action}</a></Button>
              : null
            : null}
        />
      ) : (
        filtered.length === 0 ? <Empty title="No matching Agents" detail="Try a different Agent name, ID, or owner." /> : <>
          <MobileResourceList label={view === "deleted" ? "Deleted Agents" : "Current Agents"}>
            {filtered.map((agent) => {
              const owner = owners.byUserID.get(agent.owner_user_id)?.membership;
              const status = agentStatusPresentation(agent);
              return (
                <MobileResourceItem key={agent.agent_id}>
                  <a className="group flex min-w-0 items-center gap-3" href={`#agents/${agent.agent_id}`}>
                    <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-md ${agent.desired_state === "deleted" ? "bg-slate-100 text-slate-600" : "bg-emerald-50 text-emerald-700"}`}>
                      {agent.desired_state === "deleted" ? <Archive className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium group-hover:text-primary">{agent.name}</span>
                    </span>
                    <ArrowRight className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                  </a>
                  <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-3 text-sm">
                    <div className="col-span-2">
                      <dt className="text-xs text-muted-foreground">Status</dt>
                      <dd className="mt-1 flex flex-wrap items-center gap-2">
                        <Badge value={status.lifecycle} />
                        {status.target ? <span className="text-xs text-muted-foreground">Target: {status.target}</span> : null}
                      </dd>
                    </div>
                    <div className="col-span-2 min-w-0">
                      <dt className="text-xs text-muted-foreground">Owner</dt>
                      <dd className="mt-1 truncate">{owner?.display_name ?? "Owner unavailable"}</dd>
                      {owner?.email ? <dd className="mt-0.5 truncate text-xs text-muted-foreground">{owner.email}</dd> : null}
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Updated</dt>
                      <dd className="mt-1 text-xs text-muted-foreground">{dateTime(agent.updated_at)}</dd>
                    </div>
                  </dl>
                </MobileResourceItem>
              );
            })}
          </MobileResourceList>
          <DataTable className="hidden md:block">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead className="border-b border-border bg-muted/60 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Agent</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="px-3 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((agent) => {
                const owner = owners.byUserID.get(agent.owner_user_id)?.membership;
                const status = agentStatusPresentation(agent);
                return (
                  <tr className="transition-colors hover:bg-muted/35" key={agent.agent_id}>
                    <td className="px-3 py-3.5">
                      <a className="group flex items-center gap-3" href={`#agents/${agent.agent_id}`}>
                        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-md ${agent.desired_state === "deleted" ? "bg-slate-100 text-slate-600" : "bg-emerald-50 text-emerald-700"}`}>
                          {agent.desired_state === "deleted" ? <Archive className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium group-hover:text-primary">{agent.name}</span>
                        </span>
                        <ArrowRight className="h-4 w-4 text-slate-300 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
                      </a>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge value={status.lifecycle} />
                        {status.target ? <span className="text-xs text-muted-foreground">Target: {status.target}</span> : null}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      {owner?.display_name ?? "Owner unavailable"}
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
        </>
      )}
      <ListPagination
        failure={pageFailures[view]}
        hasMore={Boolean(nextCursors[view])}
        loaded={visibleAgents.length}
        pending={pagePending[view]}
        onLoadMore={() => void loadMore(view)}
      />
      <Dialog
        dismissible={!pending}
        open={open}
        onOpenChange={setOpen}
        title="Create Agent"
        description="Build an executable Agent from a template."
      >
        <form className="grid gap-5" onSubmit={submit}>
          {formError ? <ErrorNotice message={formError} /> : null}
          <Field label="Name">
            <Input name="name" placeholder="Operations assistant" required />
          </Field>
          <Field label="Owner">
            <Select name="owner_user_id" defaultValue="" required>
              <option value="" disabled>
                Select a directory member
              </option>
              {owners.selectable.map(({ user, membership }) => (
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
              {(templates ?? []).map((template) => (
                <option value={template.template_id} key={template.template_id}>
                  {template.name} · revision {template.revision}
                </option>
              ))}
            </Select>
          </Field>
          <ListPagination
            failure={templateOptionFailure}
            hasMore={templatesHaveMore}
            loaded={templates.length}
            pending={templatesPending}
            onLoadMore={() => void (templateOptionFailure ? retryTemplates() : loadMoreTemplates())}
          />
          <div className="mt-1 flex justify-end gap-2">
            <Button
              disabled={pending}
              type="button"
              variant="secondary"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button aria-busy={pending} disabled={pending} type="submit">
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

function AgentDetail({ agentID, networkScope }: { agentID: string; networkScope?: string }) {
  const [agent, setAgent] = useState<Agent>();
  const [networkRefreshRevision, setNetworkRefreshRevision] = useState(0);
  const networkNeedsResync = useRef(false);
  const agentSnapshot = useRef<Agent | undefined>(undefined);
  const renderedAgentID = useRef(agentID);
  renderedAgentID.current = agentID;
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [streamCursor, setStreamCursor] = useState<number | null>(null);
  const latestSequence = useRef(0);
  const eventAgentID = useRef("");
  const [streamGeneration, setStreamGeneration] = useState(0);
  const {
    items: templates,
    hasMore: templatesHaveMore,
    pending: templatesPending,
    failure: templateOptionFailure,
    loadInitial: loadTemplates,
    loadMore: loadMoreTemplates,
    retry: retryTemplates,
  } = useTemplateOptions();
  const [members, setMembers] = useState<DirectoryMember[]>();
  const [directoryFailure, setDirectoryFailure] = useState<ResourceFailure>();
  const [directoryReloadGeneration, setDirectoryReloadGeneration] = useState(0);
  const [operation, setOperation] = useState<LifecycleOperation>();
  const operationRequest = useRef(0);
  const operationReadRequestID = useRef<string | undefined>(undefined);
  const terminalOperationRequestID = useRef<string | undefined>(undefined);
  const observedOperationRequestID = useRef<string | undefined>(undefined);
  const observedOperationSequence = useRef(-1);
  const observedAgentSequence = useRef(0);
  const acceptedOperationRequestID = useRef<string | undefined>(undefined);
  const [operationLoadingRequestID, setOperationLoadingRequestID] = useState<string>();
  const [operationFailure, setOperationFailure] = useState<{
    requestID: string;
    failure: ResourceFailure;
  }>();
  const [streamState, setStreamState] = useState("connecting");
  const [loadFailure, setLoadFailure] = useState<ResourceFailure>();
  const [error, setError] = useState("");
  const [acknowledgement, setAcknowledgement] = useState("");
  const [agentStateFailure, setAgentStateFailure] = useState<ResourceFailure>();
  const [agentStateRetryPending, setAgentStateRetryPending] = useState(false);
  const agentReadRequest = useRef(0);
  const [eventFailure, setEventFailure] = useState<ResourceFailure>();
  const [eventReloadGeneration, setEventReloadGeneration] = useState(0);
  const [pending, setPending] = useState("");
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [rebuildError, setRebuildError] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const loadOperation = useCallback(async (requestID: string) => {
    if (terminalOperationRequestID.current === requestID) return;
    terminalOperationRequestID.current = undefined;
    const request = operationRequest.current + 1;
    operationRequest.current = request;
    operationReadRequestID.current = requestID;
    setOperation((current) => reconcileAgentOperation(requestID, current));
    setOperationLoadingRequestID(requestID);
    setOperationFailure(undefined);
    try {
      const next = await api.operation(requestID);
      if (next.request_id !== requestID || next.agent_id !== agentID) {
        throw new Error("The lifecycle operation does not belong to this Agent.");
      }
      if (operationRequest.current === request) {
        terminalOperationRequestID.current = undefined;
        if (acceptedOperationRequestID.current === requestID && next.state !== "running") {
          acceptedOperationRequestID.current = undefined;
        }
        setOperation((current) => reconcileAgentOperation(
          agentSnapshot.current?.active_operation_request_id,
          selectOperationSnapshot(current, next),
        ));
      }
    } catch (cause) {
      if (operationRequest.current === request) {
        const failure = agentDetailFailure("operation_progress", cause);
        if (!failure.retryable) terminalOperationRequestID.current = requestID;
        setOperationFailure({
          requestID,
          failure,
        });
      }
    } finally {
      if (operationRequest.current === request) setOperationLoadingRequestID(undefined);
    }
  }, [agentID]);

  const applyAgentSnapshot = useCallback((next: Agent) => {
    if (next.agent_id !== renderedAgentID.current) return false;
    const current = agentSnapshot.current;
    if (selectAgentSnapshot(current, next) !== next) return false;
    agentSnapshot.current = next;
    setAgent(next);
    if (next.active_operation_request_id) {
      void loadOperation(next.active_operation_request_id);
      return true;
    }
    const requestID = acceptedOperationRequestID.current ?? observedOperationRequestID.current ?? operationReadRequestID.current;
    if (requestID) {
      void loadOperation(requestID);
    }
    return true;
  }, [loadOperation]);

  const rememberEventOperation = useCallback((incoming: AgentEvent[]) => {
    for (const event of incoming) {
      if (event.agent_id !== agentID) continue;
      observedAgentSequence.current = Math.max(observedAgentSequence.current, event.aggregate_sequence);
      if (!event.operation_request_id || event.global_sequence <= observedOperationSequence.current) continue;
      observedOperationSequence.current = event.global_sequence;
      // Historical hints cannot replace an acknowledged, unfinished command.
      if (!acceptedOperationRequestID.current || event.operation_request_id === acceptedOperationRequestID.current) {
        observedOperationRequestID.current = event.operation_request_id;
      }
    }
    const currentAgent = agentSnapshot.current;
    const requestID = currentAgent?.active_operation_request_id ??
      acceptedOperationRequestID.current ?? observedOperationRequestID.current;
    if (requestID && !currentAgent?.active_operation_request_id) {
      void loadOperation(requestID);
    }
  }, [agentID, loadOperation]);

  const acceptOperation = useCallback((next: LifecycleOperation) => {
    observedOperationRequestID.current = next.request_id;
    acceptedOperationRequestID.current = next.state === "running" ? next.request_id : undefined;
    // Admission must not discard a same-request progress read already in flight.
    if (operationReadRequestID.current !== next.request_id) {
      operationRequest.current += 1;
      operationReadRequestID.current = undefined;
      terminalOperationRequestID.current = undefined;
      setOperationLoadingRequestID(undefined);
      setOperationFailure(undefined);
    }
    setOperation((current) => selectOperationSnapshot(current, next));
  }, []);

  const refreshAgent = useCallback(async (reportStateError = false) => {
    const request = agentReadRequest.current + 1;
    agentReadRequest.current = request;
    try {
      const next = await api.agent(agentID);
      if (next.agent_id !== renderedAgentID.current) return undefined;
      const hadSnapshot = agentSnapshot.current !== undefined;
      applyAgentSnapshot(next);
      if (agentReadRequest.current === request) setAgentStateFailure(undefined);
      if (!hadSnapshot) setLoadFailure(undefined);
      return agentSnapshot.current ?? next;
    } catch (cause) {
      if (reportStateError && agentReadRequest.current === request) {
        if (agentSnapshot.current) {
          setAgentStateFailure(agentDetailFailure("agent_state", cause));
        }
        else setLoadFailure(resourceFailure(cause));
      }
      throw cause;
    }
  }, [agentID, applyAgentSnapshot]);

  useEffect(() => {
    let cancelled = false;
    const request = agentReadRequest.current + 1;
    agentReadRequest.current = request;
    operationRequest.current += 1;
    operationReadRequestID.current = undefined;
    terminalOperationRequestID.current = undefined;
    observedOperationRequestID.current = undefined;
    observedOperationSequence.current = -1;
    observedAgentSequence.current = 0;
    acceptedOperationRequestID.current = undefined;
    agentSnapshot.current = undefined;
    setAgent(undefined);
    setOperation(undefined);
    setOperationLoadingRequestID(undefined);
    setOperationFailure(undefined);
    setLoadFailure(undefined);
    setError("");
    setAcknowledgement("");
    setAgentStateFailure(undefined);
    api.agent(agentID)
      .then((nextAgent) => {
        if (cancelled) return;
        applyAgentSnapshot(nextAgent);
        if (nextAgent.aggregate_sequence < observedAgentSequence.current) {
          void refreshAgent(true).catch(() => undefined);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled && agentReadRequest.current === request) setLoadFailure(resourceFailure(cause));
      });
    void loadTemplates();
    return () => {
      cancelled = true;
      if (agentReadRequest.current === request) agentReadRequest.current += 1;
      operationRequest.current += 1;
    };
  }, [agentID, applyAgentSnapshot, loadTemplates, refreshAgent]);

  useEffect(() => {
    let cancelled = false;
    setDirectoryFailure(undefined);
    api.directory()
      .then((directory) => {
        if (!cancelled) setMembers(directory.users);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setDirectoryFailure(agentDetailFailure("owner_profile", cause));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [agentID, directoryReloadGeneration]);

  useEffect(() => {
    let cancelled = false;
    setEventFailure(undefined);
    setStreamState("connecting");
    if (eventAgentID.current !== agentID) {
      eventAgentID.current = agentID;
      setEvents([]);
      latestSequence.current = 0;
      setStreamCursor(null);
    }
    api.events(agentID)
      .then((page) => {
        if (cancelled) return;
        setEvents((current) => mergeAgentEvents(current, page.events));
        rememberEventOperation(page.events);
        if (agentSnapshot.current && agentSnapshot.current.aggregate_sequence < observedAgentSequence.current) {
          void refreshAgent(true).catch(() => undefined);
        }
        latestSequence.current = Math.max(latestSequence.current, page.next_sequence);
        setStreamCursor(latestSequence.current);
        setStreamGeneration((value) => value + 1);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setEventFailure(agentDetailFailure("lifecycle_events", cause));
        setStreamState("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [agentID, eventReloadGeneration, rememberEventOperation, refreshAgent]);

  useEffect(() => {
    if (streamCursor === null) return;
    const stream = new EventSource(api.eventStream(agentID, streamCursor));
    let reconnecting = false;
    let disposed = false;
    let retryTimer: number | undefined;
    stream.onopen = () => {
      if (disposed) return;
      if (networkNeedsResync.current) {
        networkNeedsResync.current = false;
        setNetworkRefreshRevision(current => current + 1);
      }
      setEventFailure(undefined);
      setStreamState("live");
    };

    async function recoverEvents(): Promise<void> {
      try {
        const page = await api.events(agentID, latestSequence.current);
        if (disposed) return;
        setEvents((current) => mergeAgentEvents(current, page.events));
        rememberEventOperation(page.events);
        latestSequence.current = page.next_sequence;
        setEventFailure(undefined);
        await recoverAgent();
        if (disposed) return;
        setStreamCursor(page.next_sequence);
        retryTimer = window.setTimeout(() => {
          setStreamGeneration((value) => value + 1);
        }, 1000);
      } catch (cause) {
        if (disposed) return;
        const failure = agentDetailFailure("lifecycle_events", cause);
        setEventFailure(failure);
        const decision = agentEventRecoveryDecision(failure);
        if (decision.action === "retry") {
          retryTimer = window.setTimeout(() => void recoverEvents(), decision.delayMs);
        } else {
          setStreamState("unavailable");
        }
      }
    }

    async function recoverAgent(): Promise<void> {
      try {
        await refreshAgent(true);
      } catch {
        // refreshAgent owns the resource-local failure state.
      }
    }

    stream.onerror = () => {
      if (reconnecting) return;
      reconnecting = true;
      networkNeedsResync.current = true;
      stream.close();
      setStreamState("resyncing");
      void recoverAgent();
      void recoverEvents();
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
        setEvents((current) => mergeAgentEvents(current, [event]));
        rememberEventOperation([event]);
        void refreshAgent(true).catch(() => undefined);
      } catch {
        setEventFailure(agentDetailFailure(
          "lifecycle_events",
          new Error("A lifecycle event could not be decoded."),
        ));
      }
    });
    return () => {
      disposed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      stream.close();
    };
  }, [agentID, refreshAgent, rememberEventOperation, streamCursor, streamGeneration]);

  async function changeLifecycle(
    action: "disable" | "enable" | "delete" | "rebuild",
    input: Record<string, unknown> = {},
  ) {
    const permitted = { rebuild: actions.canRebuild, disable: actions.canDisable, enable: actions.canEnable, delete: actions.canDelete };
    if (pending || !permitted[action]) return;
    setPending(action);
    setError("");
    setDeleteError("");
    setRebuildError("");
    setAcknowledgement("");
    try {
      // An observed terminal operation ends the previous intent, including a lost HTTP response.
      const afterOperation = visibleOperation?.state !== "running" ? visibleOperation?.request_id : undefined;
      acceptOperation(await api.lifecycle(agentID, action, input, afterOperation));
    } catch (cause) {
      const reportFailure = action === "delete" ? setDeleteError : action === "rebuild" ? setRebuildError : setError;
      reportFailure(errorMessage(cause));
      setPending("");
      return;
    }
    setAcknowledgement(`${action.charAt(0).toUpperCase()}${action.slice(1)} request accepted.`);
    setDeleteOpen(false);
    setRebuildOpen(false);
    try {
      await refreshAgent(true);
    } catch {
      // Admission succeeded; refreshAgent owns the independent read failure.
    } finally {
      setPending("");
    }
  }

  async function rebuild(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const template = (templates ?? []).find(
      (item) => item.template_id === data.get("template_id"),
    );
    if (!template) return;
    await changeLifecycle("rebuild", {
      template_id: template.template_id,
      template_revision: template.revision,
    });
  }

  async function retryAgentState() {
    if (agentStateRetryPending) return;
    setAgentStateRetryPending(true);
    try {
      await refreshAgent(true);
    } catch {
      // Keep stale-state actions closed until an authoritative read succeeds.
    } finally {
      setAgentStateRetryPending(false);
    }
  }

  if (loadFailure && !agent) {
    return (
      <ResourceFailurePage
        eyebrow="Fleet"
        failure={loadFailure}
        resource="Agent"
        returnHref="#agents"
        returnLabel="Back to Agents"
        onRetry={() => {
          setLoadFailure(undefined);
          void refreshAgent(true).catch(() => undefined);
        }}
      />
    );
  }
  if (!agent) return <Loading label="Loading Agent" />;
  const visibleOperation = reconcileAgentOperation(
    agent.active_operation_request_id,
    operation,
  );
  const operationRunning =
    pending !== "" ||
    visibleOperation?.state === "running" ||
    Boolean(agent.active_operation_request_id);
  const observedAggregate = events.reduce((highest, event) => event.agent_id === agentID ? Math.max(highest, event.aggregate_sequence) : highest, 0);
  const stateFailure = agentStateFailure ?? (agent.aggregate_sequence < observedAggregate ? {
    kind: "unavailable" as const, retryable: true,
    message: "Newer lifecycle events are available. Refresh the Agent state before making changes.",
  } : undefined);
  const actions = agentActionAvailability(
    agent,
    operationRunning || Boolean(stateFailure) || agentStateRetryPending,
  );
  const status = agentStatusPresentation(agent);
  const owner = members?.find(({ user }) => user.id === agent.owner_user_id)?.membership;
  const configuration = agentConfigurationSummary(agent);
  const configurationLinks = agentConfigurationLinks(agent);
  return (
    <div className="grid gap-6">
      <div className="-mb-2 flex flex-wrap items-center justify-between gap-2">
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
        <div className="flex flex-wrap items-center gap-2">
          {!actions.retained && (
            <Button asChild size="sm" variant="secondary">
              <a href={agentWorkspacePath(agentID)} target="_blank" rel="noopener noreferrer">
                <MessageSquareText className="h-4 w-4" />Open chat
              </a>
            </Button>
          )}
          <Button asChild size="sm" variant="ghost">
            <a href={`#audits?agent_id=${encodeURIComponent(agentID)}`}><ClipboardList className="h-4 w-4" />Execution history</a>
          </Button>
        </div>
      </div>
      <PageHeader
        eyebrow="Agent"
        title={agent.name}
        detail="Lifecycle, executable configuration, and retained operational evidence."
        actions={
          actions.retained ? (
            <Badge value="retained for audit" />
          ) : operationRunning ? (
            <Button aria-busy="true" disabled variant="secondary">
              <LoaderCircle className="h-4 w-4 animate-spin" />
              Lifecycle change in progress
            </Button>
          ) : (
            <>
              {actions.canRebuild ? (
                <Button
                  disabled={templatesPending || (templates.length === 0 && !templatesHaveMore)}
                  title={
                    templatesPending
                      ? "Loading template revisions"
                      : templateOptionFailure
                      ? "Template revisions are unavailable"
                      : templates.length === 0 && !templatesHaveMore
                        ? "No enabled template revision is available"
                        : "Rebuild Agent"
                  }
                  variant="secondary"
                  onClick={() => { setRebuildError(""); setRebuildOpen(true); }}
                >
                  <RotateCcw className="h-4 w-4" />
                  Rebuild
                </Button>
              ) : null}
              {actions.canEnable ? (
                <Button onClick={() => void changeLifecycle("enable")}>
                  <Play className="h-4 w-4" />
                  Enable
                </Button>
              ) : null}
              {actions.canDisable ? (
                <Button variant="secondary" onClick={() => void changeLifecycle("disable")}>
                  <Pause className="h-4 w-4" />
                  Disable
                </Button>
              ) : null}
              {actions.canDelete ? (
                <Button
                  aria-label="Delete Agent"
                  size="icon"
                  title="Delete Agent"
                  variant="destructive"
                  onClick={() => {
                    setDeleteError("");
                    setDeleteOpen(true);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              ) : null}
            </>
          )
        }
      />
      {acknowledgement ? <SuccessNotice message={acknowledgement} onDismiss={() => setAcknowledgement("")} /> : null}
      {error ? <ErrorNotice message={error} /> : null}
      {stateFailure ? <ResourceFailureNotice failure={stateFailure} pending={agentStateRetryPending} retryLabel="Retry Agent state" onRetry={() => void retryAgentState()} /> : null}
      {templateOptionFailure ? <ResourceFailureNotice failure={templateOptionFailure} message={`Rebuild options could not be loaded: ${templateOptionFailure.message}`} retryLabel="Retry template choices" onRetry={retryTemplates} /> : null}
      {directoryFailure ? <ResourceFailureNotice failure={directoryFailure} retryLabel="Retry owner profile" onRetry={() => {
        setDirectoryReloadGeneration((value) => value + 1);
      }} /> : null}
      {agent.failure_code ? (
        <ErrorNotice
          message={agentFailureMessage(agent)}
        />
      ) : null}
      {actions.retained ? (
        <div className="flex items-start gap-3 rounded-md border border-border bg-white p-4 shadow-xs">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
            <Archive className="h-4 w-4" aria-hidden="true" />
          </span>
          <div>
            <p className="text-sm font-medium">Deleted Agent record</p>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              Runtime compute and workspace have been removed. This record and its lifecycle events remain available for audit.
            </p>
          </div>
        </div>
      ) : null}
      <div className="flex flex-col gap-4 rounded-md border border-border bg-white p-4 shadow-xs sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-md bg-muted text-muted-foreground">
            <Bot className="h-[18px] w-[18px]" aria-hidden="true" />
          </span>
          <div>
            <p className="text-sm font-medium capitalize">{agent.lifecycle_state.replaceAll("_", " ")}{agent.activation_state ? ` / ${agent.activation_state}` : ""}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {status.target ? `${operationRunning ? "Transitioning toward" : "Requested state:"} ${status.target.toLowerCase()}` : agent.runtime_state === "waiting" ? "Waiting for the Runtime to become ready" : agent.runtime_observed_at ? `Last observed ${dateTime(agent.runtime_observed_at)}` : "Runtime status has not been observed yet"}
            </p>
          </div>
        </div>
        <Badge className="w-fit" value={status.lifecycle} />
      </div>
      {agent.activation_state === "enabled" && (agent.runtime_reason || agent.runtime_detail) ? (
        <div role="status" className="border-l-2 border-amber-400 px-4 py-2 text-sm">
          <p className="font-medium">{agent.runtime_reason?.replaceAll("_", " ") ?? "Runtime status"}</p>
          {agent.runtime_detail ? <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{agent.runtime_detail}</p> : null}
        </div>
      ) : null}
      <Section
        title="Build configuration"
      >
        {configuration && agent.configuration ? (
          <div className="grid gap-px overflow-hidden rounded-md border border-border bg-border shadow-xs sm:grid-cols-2 lg:grid-cols-3">
            <Fact
              label="Template"
              value={
                <a className="group block" href={configurationLinks?.template}>
                  <span className="font-medium group-hover:text-primary">{configuration.template}</span>
                </a>
              }
            />
            <Fact
              label="Model Profile"
              value={
                <a className="group block" href={configurationLinks?.model} title="View current model settings">
                  <span className="font-medium group-hover:text-primary">{configuration.model}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {configuration.modelRevision}
                  </span>
                </a>
              }
            />
            <Fact label="Model limits" value={configuration.limits} />
            <Fact label="Input formats" value={modelInputLabel(agent.configuration.model_profile.model)} />
            <Fact label="Model endpoint" value={agent.configuration.model_profile.model.base_url} />
            <Fact label="Temperature" value={agent.configuration.model_profile.model.temperature ?? "Provider default"} />
            <Fact label="Execution policy" value={configuration.executionPolicy} />
            <div className="bg-white p-4 sm:col-span-2">
              <p className="text-xs font-medium text-muted-foreground">Runtime image</p>
              <code className="mt-2 block break-all text-xs leading-5">{configuration.runtimeImage}</code>
            </div>
            <div className="bg-white p-4 sm:col-span-2 lg:col-span-3">
              <p className="mb-3 text-xs font-medium text-muted-foreground">Token rates at build (USD / 1M tokens)</p>
              <ModelRates pricing={agent.configuration.model_profile.model.pricing} />
            </div>
          </div>
        ) : (
          <Empty
            title="No build configuration"
            detail={
              agent.lifecycle_state === "deleted"
                ? "No active executable configuration remains after deletion."
                : agent.lifecycle_state === "not_created"
                ? "Configuration appears after Runtime creation completes."
                : operationRunning
                ? "Configuration becomes available when the lifecycle change completes."
                : agentRecoveryAvailable(agent)
                ? "Rebuild can restore the execution environment from a selected template. The previous successful execution remains in the retained history."
                : "No executable configuration is currently available. Correct the template or Runtime configuration before creating a new Agent."
            }
          />
        )}
      </Section>
      {agent.configuration ? <Section title="Deployed MCP servers"><ManagedMCPSummary servers={agent.configuration.runtime.mcp_servers} /></Section> : null}
      <AgentNetworkPolicy agent={agent} scope={networkScope} refreshRevision={networkRefreshRevision} />
      <div className="grid gap-px overflow-hidden rounded-md border border-border bg-border shadow-xs sm:grid-cols-2 lg:grid-cols-3">
        <Fact
          label="Owner"
          value={owner ? (
            <span>
              <span className="block font-medium">{owner.display_name}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{owner.email}</span>
            </span>
          ) : "Owner unavailable"}
        />
        <Fact
          label="Runtime environment"
          value={agent.lifecycle_state === "deleted" ? "Removed" : agent.activation_state === "disabled" ? "Stopped" : agent.runtime ? <Badge value={agent.runtime_state} /> : "Not created"}
        />
        <Fact
          label="Executable configuration"
          value={agent.executable_execution_revision ? "Published" : "Not published"}
        />
        <Fact
          label="Live updates"
          value={
            <span className="flex items-center gap-2 capitalize">
              <span
                className={`h-2 w-2 rounded-full ${streamState === "live" ? "bg-emerald-500" : "bg-amber-500"}`}
              />
              {streamState}
            </span>
          }
        />
        <Fact label="Created" value={dateTime(agent.created_at)} />
        <Fact label="Updated" value={dateTime(agent.updated_at)} />
      </div>
      <TechnicalDetails
        facts={[
          ["Agent ID", agent.agent_id],
          ["Lifecycle sequence", String(agent.aggregate_sequence)],
          ["Runtime revision", agent.runtime?.runtime_revision ?? "Not assigned"],
          ["Execution revision", agent.executable_execution_revision ?? "Not published"],
        ]}
      />
      {visibleOperation || operationLoadingRequestID || operationFailure ? (
        <Section title={agent.active_operation_request_id || visibleOperation?.state === "running" ? "Current operation" : "Last operation"}>
          <div className="grid gap-3">
            {operationFailure ? (
              <ResourceFailureNotice
                failure={operationFailure.failure}
                retryLabel="Retry operation"
                onRetry={() => void loadOperation(operationFailure.requestID)}
              />
            ) : null}
            {operationLoadingRequestID && !visibleOperation ? (
              <div className="flex items-center gap-3 rounded-md border border-border bg-white p-4 text-sm shadow-xs">
                <LoaderCircle className="h-4 w-4 animate-spin text-muted-foreground" />
                Loading operation progress
              </div>
            ) : null}
            {visibleOperation ? (
              <div className="flex flex-col gap-3 rounded-md border border-border bg-white p-4 shadow-xs sm:flex-row sm:items-center">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-muted text-slate-600">
                  {visibleOperation.state === "running" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CircleDot className="h-4 w-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium capitalize">{visibleOperation.kind}</span>
                    <Badge value={visibleOperation.state} />
                  </div>
                  {visibleOperation.phase && visibleOperation.phase !== visibleOperation.state ? (
                    <p className="mt-1 text-xs capitalize text-muted-foreground">{visibleOperation.phase.replaceAll("_", " ")}</p>
                  ) : null}
                </div>
                {visibleOperation.error_detail || visibleOperation.error_code ? (
                  <div className="min-w-0 text-sm text-red-700">
                    {visibleOperation.error_detail ? <p className="break-words">{visibleOperation.error_detail}</p> : null}
                    {visibleOperation.error_code ? <p className="mt-1 text-xs">Code: <code className="break-all">{visibleOperation.error_code}</code></p> : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </Section>
      ) : null}
      <Section
        title="Lifecycle events"
        detail="Ordered history of changes to this Agent."
      >
        {eventFailure ? (
          <div className="mb-4">
            <ResourceFailureNotice
              failure={eventFailure}
              retryLabel="Retry lifecycle events"
              onRetry={() => {
                setStreamCursor(null);
                setEventReloadGeneration((value) => value + 1);
              }}
            />
          </div>
        ) : null}
        {events.length === 0 ? (
          eventFailure ? null : (
            <Empty
              title="No lifecycle events"
              detail="Events appear as the Agent changes state."
            />
          )
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-md border border-border bg-white shadow-xs">
            {[...events].reverse().map((event) => (
              <div
                className="grid gap-2 px-4 py-3.5 sm:grid-cols-[auto_minmax(180px,1fr)_auto] sm:items-center"
                key={event.event_id}
              >
                <span className="hidden h-7 w-7 place-items-center rounded-full bg-muted text-slate-500 sm:grid">
                  <CircleDot className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <div>
                  <p className="text-sm font-medium">{agentEventLabel(event.event_type)}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">Event {event.aggregate_sequence}</p>
                  {event.trace_id ? (
                    <details className="mt-1 text-xs text-muted-foreground">
                      <summary className="w-fit cursor-pointer select-none hover:text-foreground">Trace details</summary>
                      <code className="mt-1 block break-all">{event.trace_id}</code>
                    </details>
                  ) : null}
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
        dismissible={pending !== "rebuild"}
        open={rebuildOpen}
        onOpenChange={setRebuildOpen}
        title="Rebuild Agent"
        description="Publish a new execution revision from the selected template."
      >
        <form className="grid gap-4" onSubmit={rebuild}>
          {rebuildError ? <ErrorNotice message={rebuildError} /> : null}
          <Field label="Template">
            <Select name="template_id" defaultValue="" required>
              <option value="" disabled>
                Select a template revision
              </option>
              {(templates ?? []).map((template) => (
                <option value={template.template_id} key={template.template_id}>
                  {template.name} · revision {template.revision}
                </option>
              ))}
            </Select>
          </Field>
          <ListPagination
            failure={templateOptionFailure}
            hasMore={templatesHaveMore}
            loaded={templates.length}
            pending={templatesPending}
            onLoadMore={() => void (templateOptionFailure ? retryTemplates() : loadMoreTemplates())}
          />
          <div className="flex justify-end gap-2">
            <Button
              disabled={pending === "rebuild"}
              type="button"
              variant="secondary"
              onClick={() => setRebuildOpen(false)}
            >
              Cancel
            </Button>
            <Button aria-busy={pending === "rebuild"} disabled={!actions.canRebuild || templatesPending} type="submit">
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
      <Dialog
        dismissible={pending !== "delete"}
        open={deleteOpen}
        onOpenChange={(open) => {
          setDeleteOpen(open);
          if (!open) setDeleteError("");
        }}
        title="Delete Agent"
        description={`${agent.name} will stop accepting work immediately.`}
      >
        <div className="grid gap-5">
          {deleteError ? <ErrorNotice message={deleteError} /> : null}
          <div className="rounded-md border border-red-200 bg-red-50/60 p-4 text-sm text-red-950">
            <p className="font-medium">Runtime compute and workspace will be removed.</p>
            <p className="mt-1 leading-5 text-red-900/75">
              The Agent record and lifecycle events remain available in the deleted inventory for audit.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              disabled={pending === "delete"}
              type="button"
              variant="secondary"
              onClick={() => {
                setDeleteOpen(false);
                setDeleteError("");
              }}
            >
              Cancel
            </Button>
            <Button
              aria-busy={pending === "delete"}
              disabled={!actions.canDelete}
              type="button"
              variant="destructive"
              onClick={() => void changeLifecycle("delete")}
            >
              {pending === "delete" ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              Delete Agent
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="bg-white p-4">
      <p className="text-xs font-medium text-muted-foreground">
        {label}
      </p>
      <div className="mt-2 text-sm">{value}</div>
    </div>
  );
}

function TechnicalDetails({ facts }: { facts: Array<readonly [string, string]> }) {
  return (
    <details className="border-y border-border py-3 text-sm">
      <summary className="w-fit cursor-pointer select-none font-medium text-muted-foreground hover:text-foreground">
        Technical identifiers
      </summary>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        {facts.map(([label, value]) => (
          <div className="min-w-0" key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1"><code className="break-all text-xs">{value}</code></dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
