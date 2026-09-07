import {
  ArrowRight,
  Bot,
  Boxes,
  BrainCircuit,
  CircleAlert,
  CircleCheck,
  Clock3,
  RefreshCw,
  Server,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { PageHeader, Section } from "../components/page";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Empty, ErrorNotice, Loading } from "../components/ui/feedback";
import { api } from "../lib/api";
import { dateTime } from "../lib/format";
import { boundedSnapshot, overviewResourceSummary, overviewRefreshAllowed } from "../lib/overview";
import { resourceFailure, type ResourceFailure } from "../lib/resource-failure";
import { platformSetup, type SetupStep } from "../lib/setup";
import type { Overview } from "../lib/types";
import { cn } from "../lib/utils";

type Metric = {
  label: string;
  value: number | string;
  detail: string;
  icon: LucideIcon;
  tone: string;
  href: string;
};

export function DashboardPage() {
  const [data, setData] = useState<Overview>();
  const [failure, setFailure] = useState<ResourceFailure>();
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void api.overview(controller.signal).then((overview) => {
      if (controller.signal.aborted) return;
      setData(overview);
      setFailure(undefined);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setFailure(resourceFailure(cause));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [refresh]);

  const sectionFailures = data ? overviewResourceSummary(data).degraded : [];
  const canRefresh = overviewRefreshAllowed(failure, sectionFailures);
  const refreshAction = canRefresh ? (
    <Button
      aria-busy={loading}
      disabled={loading}
      size="sm"
      variant="secondary"
      onClick={() => {
        if (loading) return;
        setLoading(true);
        setRefresh((value) => value + 1);
      }}
    >
      <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
      {loading ? "Refreshing overview" : "Retry overview"}
    </Button>
  ) : undefined;

  if (!data && failure) {
    return (
      <div className="grid gap-5">
        <PageHeader
          eyebrow="Control plane"
          title="Overview"
          detail="Organization inventory, configuration readiness, and current Agent fleet state."
        />
        <ErrorNotice
          message={failure.message}
          action={refreshAction}
        />
      </div>
    );
  }
  if (!data) return <Loading label="Loading platform overview" />;

  const agents = data.agents.status === "available" ? data.agents.data.items : [];
  const agentsAvailable = data.agents.status === "available";
  const resources = overviewResourceSummary(data);
  const available = agents.filter((agent) => agent.lifecycle_state === "available").length;
  const disabled = agents.filter((agent) => agent.lifecycle_state === "disabled").length;
  const failed = agents.filter((agent) => agent.lifecycle_state === "failed").length;
  const changing = Math.max(0, agents.length - available - disabled - failed);
  const agentCursor = data.agents.status === "available" ? data.agents.data.next_cursor : null;
  const agentSnapshot = boundedSnapshot(agents.length, agentCursor);
  const setup = platformSetup(data);
  const metrics: Metric[] = [
    {
      label: "Available Agents",
      value: agentsAvailable ? available : "—",
      detail: agentsAvailable
        ? agentSnapshot.hasMore
          ? `From ${agentSnapshot.count} loaded Agents`
          : `${agentSnapshot.count} total in fleet`
        : "Inventory unavailable",
      icon: Bot,
      tone: "bg-emerald-50 text-emerald-700",
      href: "#agents",
    },
    {
      label: "Active members",
      value: resources.directory.value,
      detail: resources.directory.detail,
      icon: Users,
      tone: "bg-sky-50 text-sky-700",
      href: "#directory",
    },
    {
      label: "Model providers",
      value: resources.models.value,
      detail: resources.models.detail,
      icon: BrainCircuit,
      tone: "bg-violet-50 text-violet-700",
      href: "#models",
    },
    {
      label: "Agent templates",
      value: resources.templates.value,
      detail: resources.templates.detail,
      icon: Boxes,
      tone: "bg-amber-50 text-amber-700",
      href: "#templates",
    },
  ];

  return (
    <div className="grid gap-8">
      <PageHeader
        eyebrow="Control plane"
        title="Overview"
        detail="Organization inventory, configuration readiness, and current Agent fleet state."
        actions={
          <Button asChild>
            <a href={setup.next?.href ?? "#agents"}>
              {setup.next?.action ?? "View Agent fleet"}
              <ArrowRight className="h-4 w-4" />
            </a>
          </Button>
        }
      />
      {failure || resources.degraded.length > 0 ? (
        <ErrorNotice
          message={failure
            ? `${failure.message}. Showing the previously loaded overview.`
            : resources.degraded.map((section) => section.message).join("; ")}
          action={refreshAction}
        />
      ) : null}

      <section aria-label="Organization summary" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map(({ label, value, detail, icon: Icon, tone, href }) => (
          <a
            className="group rounded-md border border-border bg-white p-4 shadow-sm transition-[border-color,box-shadow] hover:border-slate-300 hover:shadow-md"
            href={href}
            key={label}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-muted-foreground">{label}</p>
                <p className="mt-2 text-[28px] font-semibold leading-none">{value}</p>
              </div>
              <span className={cn("grid h-9 w-9 place-items-center rounded-md", tone)}>
                <Icon className="h-4 w-4" aria-hidden="true" />
              </span>
            </div>
            <div className="mt-4 flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>{detail}</span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
            </div>
          </a>
        ))}
      </section>

      <div className="grid gap-7 xl:grid-cols-[minmax(0,1.45fr)_minmax(300px,0.75fr)]">
        <Section
          title="Agent inventory"
          detail={agentSnapshot.hasMore
            ? `Showing a preview from the first ${agentSnapshot.count} loaded Agents.`
            : "Current authoritative projections from Agent Controller."}
          action={<a className="text-sm font-medium text-primary hover:underline" href="#agents">View all</a>}
        >
          {!agentsAvailable ? (
            <ErrorNotice message="Agent inventory is temporarily unavailable." />
          ) : agents.length === 0 ? (
            <Empty
              title="No Agents"
              detail={setup.next?.summary ?? "Create the first executable Agent."}
              action={setup.next ? <Button asChild size="sm"><a href={setup.next.href}>{setup.next.action}<ArrowRight className="h-4 w-4" /></a></Button> : null}
            />
          ) : (
            <div className="overflow-hidden rounded-md border border-border bg-white shadow-sm">
              <div className="divide-y divide-border">
                {agents.slice(0, 6).map((agent) => (
                  <a
                    className="group grid gap-3 px-4 py-3.5 transition-colors hover:bg-muted/55 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center"
                    href={`#agents/${agent.agent_id}`}
                    key={agent.agent_id}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-muted text-slate-600">
                        <Bot className="h-4 w-4" aria-hidden="true" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{agent.name}</span>
                      </span>
                    </div>
                    <Badge className="w-fit" value={agent.lifecycle_state} />
                    <time className="text-xs text-muted-foreground">{dateTime(agent.updated_at)}</time>
                  </a>
                ))}
              </div>
            </div>
          )}
        </Section>

        <Section
          title="Fleet state"
          detail={agentSnapshot.hasMore
            ? `Lifecycle distribution within ${agentSnapshot.count} loaded Agents.`
            : "Lifecycle distribution across the organization."}
        >
          <div className="rounded-md border border-border bg-white p-5 shadow-sm">
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="text-3xl font-semibold leading-none">{agentsAvailable ? agentSnapshot.display : "—"}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {agentSnapshot.hasMore ? "Agents represented" : "Agents tracked"}
                </p>
              </div>
              <span className="grid h-10 w-10 place-items-center rounded-md bg-slate-100 text-slate-600">
                <Server className="h-[18px] w-[18px]" aria-hidden="true" />
              </span>
            </div>
            <div className="mt-5 flex h-2 overflow-hidden rounded-full bg-muted" aria-label="Fleet lifecycle distribution">
              {agentsAvailable && agents.length > 0 ? (
                <>
                  <span className="bg-emerald-500" style={{ width: `${(available / agents.length) * 100}%` }} />
                  <span className="bg-amber-400" style={{ width: `${(changing / agents.length) * 100}%` }} />
                  <span className="bg-slate-400" style={{ width: `${(disabled / agents.length) * 100}%` }} />
                  <span className="bg-red-500" style={{ width: `${(failed / agents.length) * 100}%` }} />
                </>
              ) : null}
            </div>
            {agentsAvailable ? (
              <div className="mt-5 grid gap-3 text-sm">
                <FleetState icon={CircleCheck} label="Available" value={available} className="text-emerald-700" />
                <FleetState icon={Clock3} label="Changing" value={changing} className="text-amber-700" />
                <FleetState icon={Server} label="Disabled" value={disabled} className="text-slate-600" />
                <FleetState icon={CircleAlert} label="Failed" value={failed} className="text-red-700" />
              </div>
            ) : <p className="mt-5 text-sm text-muted-foreground">Lifecycle distribution is unavailable.</p>}
          </div>
        </Section>
      </div>

      <Section title="Launch readiness" detail="The shortest supported path from an empty organization to an executable Agent.">
        <div className="grid overflow-hidden rounded-md border border-border bg-white shadow-sm sm:grid-cols-2 xl:grid-cols-4 xl:divide-x xl:divide-border">
          {setup.steps.map((step) => <ReadinessItem key={step.key} step={step} />)}
        </div>
      </Section>
    </div>
  );
}

function FleetState({ icon: Icon, label, value, className }: { icon: LucideIcon; label: string; value: number; className: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className={cn("h-4 w-4", className)} aria-hidden="true" />
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-auto font-medium">{value}</span>
    </div>
  );
}

function ReadinessItem({ step }: { step: SetupStep }) {
  const ready = step.state === "ready";
  const unavailable = step.state === "unavailable";
  return (
    <a className="flex items-center gap-3 border-b border-border p-4 transition-colors hover:bg-muted/45 last:border-b-0 sm:[&:nth-child(odd)]:border-r xl:border-b-0 xl:[&:nth-child(odd)]:border-r-0" href={step.href}>
      <span className={cn(
        "grid h-8 w-8 place-items-center rounded-md",
        ready
          ? "bg-emerald-50 text-emerald-700"
          : unavailable
          ? "bg-red-50 text-red-700"
          : step.state === "blocked"
          ? "bg-slate-100 text-slate-500"
          : "bg-amber-50 text-amber-700",
      )}>
        {ready ? <CircleCheck className="h-4 w-4" /> : <CircleAlert className="h-4 w-4" />}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{step.label}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{step.summary}</span>
      </span>
      <ArrowRight className="ml-auto h-4 w-4 text-slate-300" aria-hidden="true" />
    </a>
  );
}
