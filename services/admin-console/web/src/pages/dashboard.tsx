import { Bot, Boxes, BrainCircuit, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { PageHeader, Section } from "../components/page";
import { Badge } from "../components/ui/badge";
import { ErrorNotice, Loading } from "../components/ui/feedback";
import { api, errorMessage } from "../lib/api";
import { dateTime } from "../lib/format";
import type { Overview } from "../lib/types";

export function DashboardPage() {
  const [data, setData] = useState<Overview>();
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .overview()
      .then(setData)
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, []);

  if (error) return <ErrorNotice message={error} />;
  if (!data) return <Loading label="Loading platform overview" />;
  if (data.agents.status !== "available")
    return <ErrorNotice message="Agent inventory is unavailable." />;

  const agents = data.agents.data;
  const degraded = [data.directory, data.model_profiles, data.templates]
    .filter((section) => section.status === "unavailable")
    .map((section) => section.error.message);
  const available = agents.items.filter(
    (agent) => agent.lifecycle_state === "available",
  ).length;
  const metrics = [
    {
      label: "Directory users",
      value:
        data.directory.status === "available"
          ? data.directory.data.users.length
          : "—",
      icon: Users,
    },
    {
      label: "Model profiles",
      value:
        data.model_profiles.status === "available"
          ? data.model_profiles.data.items.length
          : "—",
      icon: BrainCircuit,
    },
    {
      label: "Templates",
      value:
        data.templates.status === "available"
          ? data.templates.data.items.length
          : "—",
      icon: Boxes,
    },
    { label: "Available Agents", value: available, icon: Bot },
  ];

  return (
    <div className="grid gap-8">
      <PageHeader
        title="Overview"
        detail="Current organization inventory and Agent fleet state."
      />
      {degraded.length > 0 ? (
        <ErrorNotice
          message={`Some overview data is unavailable: ${degraded.join("; ")}`}
        />
      ) : null}
      <div className="grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map(({ label, value, icon: Icon }) => (
          <div className="bg-background p-4" key={label}>
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-xs font-medium uppercase tracking-wide">
                {label}
              </span>
              <Icon className="h-4 w-4" />
            </div>
            <p className="mt-3 text-2xl font-semibold">{value}</p>
          </div>
        ))}
      </div>
      <Section
        title="Recent Agents"
        detail="The latest authoritative Agent projections."
      >
        {agents.items.length === 0 ? (
          <p className="border-y border-dashed border-border py-10 text-center text-sm text-muted-foreground">
            No Agents have been created.
          </p>
        ) : (
          <div className="divide-y divide-border border-y border-border">
            {agents.items.slice(0, 6).map((agent) => (
              <a
                className="flex items-center justify-between gap-4 py-3 hover:bg-muted/50"
                href={`#agents/${agent.agent_id}`}
                key={agent.agent_id}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{agent.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Updated {dateTime(agent.updated_at)}
                  </p>
                </div>
                <Badge value={agent.lifecycle_state} />
              </a>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
