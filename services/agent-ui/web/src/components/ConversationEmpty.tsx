import { Bot } from "lucide-react";
import type { AgentSummary } from "../lib/types";

export function ConversationEmpty({ agent }: { agent: AgentSummary }) {
  return (
    <div className="empty-thread">
      <span className="empty-thread-mark">
        <Bot size={22} aria-hidden="true" />
      </span>
      <h2>Start with {agent.name}</h2>
    </div>
  );
}
