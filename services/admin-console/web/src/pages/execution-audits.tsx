import { ArrowLeft, FileText, Filter, RefreshCw } from "lucide-react";
import { useCallback, useState, type FormEvent, type ReactNode } from "react";
import {
  DataTable,
  ListPagination,
  PageHeader,
  ResourceFailureNotice,
  ResourceFailurePage,
  Section,
} from "../components/page";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Empty, Loading } from "../components/ui/feedback";
import { Field, Input } from "../components/ui/input";
import { api } from "../lib/api";
import type {
  AuditFilters,
  AuditPage,
  ExecutionAuditSummary,
  ExecutionAuditEvent,
  ExecutionAuditPermission,
} from "../lib/execution-audit";
import { dateTime } from "../lib/format";
import { useAuditPage, useAuditRead } from "./audit-reader";

export function ExecutionAuditsPage({
  runID,
  agentID,
}: {
  runID?: string;
  agentID?: string;
}) {
  return runID ? (
    <AuditDetail key={runID} runID={runID} />
  ) : (
    <AuditList key={agentID ?? "all"} agentID={agentID} />
  );
}

function AuditList({ agentID }: { agentID?: string }) {
  const [filters, setFilters] = useState<AuditFilters>({ agent_id: agentID });
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setFilters(
      Object.fromEntries(
        ["agent_id", "session_id", "created_from", "created_until"].map(
          (name) => [name, String(data.get(name) ?? "")],
        ),
      ),
    );
  }
  return (
    <div className="grid gap-5">
      <PageHeader
        eyebrow="Audit"
        title="Execution history"
        detail="Retained executions, original requests and tool activity."
      />
      <form
        aria-label="Execution filters"
        className="grid gap-3 border-b border-border pb-5 sm:grid-cols-2 xl:grid-cols-5"
        onSubmit={apply}
      >
        <Field label="Agent ID">
          <Input name="agent_id" defaultValue={agentID} />
        </Field>
        <Field label="Session ID">
          <Input name="session_id" />
        </Field>
        <Field label="Created from (UTC)">
          <Input name="created_from" placeholder="YYYY-MM-DDTHH:mm:ssZ" />
        </Field>
        <Field label="Created until (UTC)">
          <Input name="created_until" placeholder="YYYY-MM-DDTHH:mm:ssZ" />
        </Field>
        <Button className="self-end" type="submit" variant="secondary">
          <Filter className="h-4 w-4" />
          Apply filters
        </Button>
      </form>
      <AuditListResults key={JSON.stringify(filters)} filters={filters} />
    </div>
  );
}

const runKey = (item: ExecutionAuditSummary) => item.run_id;
const eventKey = (item: ExecutionAuditEvent) => item.id;
const permissionKey = (item: ExecutionAuditPermission) => item.tool_call_id;

function RefreshButton({
  pending,
  onClick,
  label,
}: {
  pending: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <Button
      aria-label={label}
      title={label}
      size="icon"
      variant="ghost"
      disabled={pending}
      onClick={onClick}
    >
      <RefreshCw className="h-4 w-4" />
    </Button>
  );
}

function AuditListResults({ filters }: { filters: AuditFilters }) {
  const read = useCallback(
    (cursor: string | undefined, signal: AbortSignal) =>
      api.executionAudits(filters, cursor, signal),
    [filters],
  );
  const page = useAuditPage(read, runKey);
  return (
    <Section
      title="Executions"
      action={
        <RefreshButton
          pending={page.pending}
          onClick={page.refresh}
          label="Refresh executions"
        />
      }
    >
      {page.items === undefined ? (
        page.failure ? (
          <ResourceFailureNotice
            failure={page.failure}
            retryLabel="Retry executions"
            onRetry={page.refresh}
          />
        ) : (
          <Loading label="Loading executions" />
        )
      ) : (
        <div className="grid gap-4">
          {page.items.length === 0 ? (
            <Empty
              title="No executions"
              detail="No retained execution matches these filters."
            />
          ) : (
            <DataTable>
              <table className="w-full table-fixed text-left text-sm">
                <thead className="border-b border-border text-xs text-muted-foreground">
                  <tr>
                    <th className="p-3 font-medium">Execution</th>
                    <th className="p-3 font-medium">Agent / Session</th>
                    <th className="w-28 p-3 font-medium">State</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {page.items.map((item) => (
                    <tr key={item.run_id}>
                      <td className="break-all p-3 align-top">
                        <a
                          className="font-medium text-primary hover:underline"
                          href={`#audits/${encodeURIComponent(item.run_id)}`}
                        >
                          {item.run_id}
                        </a>
                        <time
                          className="mt-1 block text-xs text-muted-foreground"
                          dateTime={item.created_at}
                          title={item.created_at}
                        >
                          {dateTime(item.created_at)}
                        </time>
                      </td>
                      <td className="break-all p-3 align-top">
                        <span className="block">{item.agent_id}</span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {item.session_id}
                        </span>
                      </td>
                      <td className="p-3 align-top">
                        <Badge value={item.state} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DataTable>
          )}
          <ListPagination
            loaded={page.items.length}
            hasMore={page.hasMore}
            pending={page.pending}
            failure={page.failure}
            onLoadMore={page.loadMore}
          />
        </div>
      )}
    </Section>
  );
}

function JSONContent({ value }: { value: unknown }) {
  return (
    <pre className="max-h-96 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-5">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function AuditDetail({ runID }: { runID: string }) {
  return (
    <div className="grid min-w-0 gap-6 [overflow-wrap:anywhere]">
      <AuditRecord runID={runID} />
      <ExecutionEvents runID={runID} />
      <PermissionRecords runID={runID} />
    </div>
  );
}

function AuditRecord({ runID }: { runID: string }) {
  const read = useCallback(
    (signal: AbortSignal) => api.executionAudit(runID, signal),
    [runID],
  );
  const { state, retry } = useAuditRead(read);
  if (state.status === "loading") return <Loading label="Loading execution" />;
  if (state.status === "error")
    return (
      <ResourceFailurePage
        eyebrow="Audit"
        resource="Execution"
        returnHref="#audits"
        returnLabel="Back to execution history"
        failure={state.failure}
        onRetry={retry}
      />
    );
  const record = state.data;
  return (
    <div className="grid min-w-0 gap-6 [overflow-wrap:anywhere]">
      <Button asChild className="w-fit" size="sm" variant="ghost">
        <a href="#audits">
          <ArrowLeft className="h-4 w-4" />
          Execution history
        </a>
      </Button>
      <PageHeader
        eyebrow="Audit"
        title="Execution detail"
        detail={runID}
        actions={
          <RefreshButton
            pending={false}
            onClick={retry}
            label="Refresh execution detail"
          />
        }
      />
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
        {[
          ["Agent", record.agent_id],
          ["Session", record.session_id],
          ["User", record.principal_id],
          ["State", record.state],
          ["Created", record.created_at],
          ["Updated", record.updated_at],
          ["Outcome", record.terminal_class],
          ["Executor", record.executor_state],
          ["Tool effects", record.tool_effect_state],
          ["Stop reason", record.stop_reason],
          ["Error", record.error_class],
          ["Unknown effect source", record.unknown_effect_source],
        ].map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 break-all">{value ?? "Not recorded"}</dd>
          </div>
        ))}
      </dl>
      <Section title="Original input">
        <JSONContent value={record.input} />
      </Section>
      <Section title="Execution configuration">
        <details className="min-w-0">
          <summary className="flex cursor-pointer items-center gap-2 py-2 text-sm">
            <FileText className="h-4 w-4" />
            Configuration snapshot
          </summary>
          <JSONContent value={record.execution_snapshot} />
        </details>
      </Section>
      <Section title="Usage">
        <JSONContent value={record.usage_measurements} />
      </Section>
    </div>
  );
}

function AuditStream<T>({
  title,
  emptyTitle,
  retryLabel,
  read,
  identity,
  renderItem,
}: {
  title: string;
  emptyTitle: string;
  retryLabel: string;
  read: (
    cursor: string | undefined,
    signal: AbortSignal,
  ) => Promise<AuditPage<T>>;
  identity: (item: T) => string;
  renderItem: (item: T) => ReactNode;
}) {
  const page = useAuditPage(read, identity);
  return (
    <div role="region" aria-label={title} className="min-w-0">
      <Section
        title={title}
        action={
          <RefreshButton
            pending={page.pending}
            onClick={page.refresh}
            label={`Refresh ${title.toLowerCase()}`}
          />
        }
      >
        {page.items === undefined ? (
          page.failure ? (
            <ResourceFailureNotice
              failure={page.failure}
              retryLabel={retryLabel}
              onRetry={page.refresh}
            />
          ) : (
            <Loading label={`Loading ${title.toLowerCase()}`} />
          )
        ) : (
          <div className="grid min-w-0 gap-4">
            {page.items.length === 0 ? (
              <Empty title={emptyTitle} detail="No records on this page." />
            ) : (
              <ul className="min-w-0 divide-y divide-border border-y border-border">
                {page.items.map((item) => (
                  <li className="min-w-0 py-3" key={identity(item)}>
                    {renderItem(item)}
                  </li>
                ))}
              </ul>
            )}
            <ListPagination
              loaded={page.items.length}
              hasMore={page.hasMore}
              pending={page.pending}
              failure={page.failure}
              onLoadMore={page.loadMore}
            />
          </div>
        )}
      </Section>
    </div>
  );
}

function ExecutionEvents({ runID }: { runID: string }) {
  const read = useCallback(
    (cursor: string | undefined, signal: AbortSignal) =>
      api.executionAuditEvents(runID, cursor, signal),
    [runID],
  );
  return (
    <AuditStream
      title="Execution events"
      emptyTitle="No execution events"
      retryLabel="Retry execution events"
      read={read}
      identity={eventKey}
      renderItem={(item) => (
        <details>
          <summary className="cursor-pointer break-all text-sm">
            <span className="mr-2 text-xs text-muted-foreground">
              {item.sequence}
            </span>
            <span className="font-medium">{item.kind}</span>
            <time
              className="ml-3 text-xs text-muted-foreground"
              dateTime={item.created_at}
              title={item.created_at}
            >
              {dateTime(item.created_at)}
            </time>
          </summary>
          <p className="my-2 text-xs text-muted-foreground">
            {item.visible
              ? "Included in conversation"
              : "Internal execution event"}
          </p>
          <JSONContent value={item.payload} />
        </details>
      )}
    />
  );
}

function PermissionRecords({ runID }: { runID: string }) {
  const read = useCallback(
    (cursor: string | undefined, signal: AbortSignal) =>
      api.executionAuditPermissions(runID, cursor, signal),
    [runID],
  );
  return (
    <AuditStream
      title="Permission records"
      emptyTitle="No permission records"
      retryLabel="Retry permission records"
      read={read}
      identity={permissionKey}
      renderItem={(item) => (
        <details>
          <summary className="cursor-pointer break-all text-sm">
            <span className="font-medium">{item.tool_call_id}</span>
            <span className="ml-3">
              {item.decision ?? "No decision recorded"}
            </span>
          </summary>
          <dl className="my-2 grid gap-2 text-xs text-muted-foreground">
            <div>
              <dt>Requested</dt>
              <dd>{item.created_at}</dd>
            </div>
            <div>
              <dt>Decided</dt>
              <dd>{item.decided_at ?? "Not recorded"}</dd>
            </div>
            <div>
              <dt>Reason</dt>
              <dd className="break-words">{item.reason ?? "Not recorded"}</dd>
            </div>
          </dl>
          <JSONContent value={item.request} />
        </details>
      )}
    />
  );
}
