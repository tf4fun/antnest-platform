import { formatSessionCost } from "../lib/usage";
import type { SessionUsage as Usage } from "../lib/types";

export function SessionUsage({ usage, stale }: { usage?: Usage; stale: boolean }) {
  if (!usage) return null;
  return (
    <div className="session-usage" role="group" aria-label="Session usage">
      <span className="usage-metric" title="Tokens currently in context, not lifetime token consumption">
        <span>Context</span><strong>{usage.used.toLocaleString("en-US")} / {usage.size.toLocaleString("en-US")}</strong>
      </span>
      <span className="usage-metric" title={usage.cost ? `${usage.cost.currency} ${usage.cost.amount}` : "No cost has been reported for this session"}>
        <span>Known cost</span><strong>{formatSessionCost(usage.cost)}</strong>
      </span>
      <span className="usage-note" title="Reported session costs may be incomplete. This is not a billing statement.">May be incomplete</span>
      {stale ? <span className="usage-stale">Last received</span> : null}
    </div>
  );
}
