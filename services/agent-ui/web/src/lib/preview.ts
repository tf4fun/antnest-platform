import type { WorkspaceSnapshot } from "./types";

export function previewWorkspace(): WorkspaceSnapshot {
  return {
    principal: {
      userId: "preview-user",
      organizationId: "preview-org",
      displayName: "Lin Xia",
      organizationName: "Antnest Labs",
      administrator: true,
    },
    connection: "ready",
    preview: true,
    activeAgentId: "agent-research",
    activeConversationId: "conversation-market",
    agents: [
      {
        id: "agent-research",
        name: "Research Partner",
        description: "Synthesizes sources and turns evidence into decisions.",
        modelLabel: "DeepSeek V3.2",
        status: "ready",
        managementState: { lifecycle: "created", activation: "enabled", runtime: "available" },
      },
      {
        id: "agent-operations",
        name: "Operations Assistant",
        description: "Maintains recurring workflows and operational records.",
        modelLabel: "Claude Sonnet 4.6",
        status: "busy",
        managementState: { lifecycle: "created", activation: "enabled", runtime: "available" },
      },
      {
        id: "agent-finance",
        name: "Finance Analyst",
        description: "Reviews models, assumptions, and reporting inputs.",
        modelLabel: "GPT-5.4",
        status: "offline",
        managementState: { lifecycle: "created", activation: "disabled", runtime: "exited" },
      },
    ],
    conversations: [
      {
        id: "conversation-market",
        agentId: "agent-research",
        title: "Enterprise agent market signals",
        usage: { used: 8246, size: 128000, cost: { amount: 0.01234, currency: "USD" } },
        updatedAt: "2026-09-02T09:46:00+08:00",
        messages: [
          {
            id: "message-1",
            role: "user",
            content: "Review the attached notes and identify the three strongest signals for our investor update.",
            createdAt: "2026-09-02T09:42:00+08:00",
            attachments: [
              {
                id: "attachment-1",
                name: "market-notes.md",
                kind: "file",
                sizeLabel: "18 KB",
              },
            ],
          },
          {
            id: "message-2",
            role: "assistant",
            content:
              "The strongest signals are **persistent enterprise demand**, **a shift from assistants to managed agents**, and **growing pressure for vendor-independent control**.\n\nTogether they support a clear thesis: model capability is becoming abundant, while trustworthy deployment and organizational learning remain scarce.",
            createdAt: "2026-09-02T09:46:00+08:00",
            activities: [
              {
                id: "activity-1",
                label: "Read market notes",
                tool: "read",
                status: "completed",
                summary: "Read 184 lines from market-notes.md",
                detail: "workspace/market-notes.md · lines 1-184",
                durationMs: 184,
              },
              {
                id: "activity-2",
                label: "Compare evidence",
                tool: "bash",
                status: "completed",
                summary: "Grouped 27 observations into 6 themes",
                detail: "python scripts/group_signals.py market-notes.md",
                durationMs: 932,
              },
            ],
          },
        ],
      },
      {
        id: "conversation-brief",
        agentId: "agent-research",
        title: "Weekly technology brief",
        usage: { used: 0, size: 128000 },
        updatedAt: "2026-09-01T16:12:00+08:00",
        messages: [],
      },
      {
        id: "conversation-incident",
        agentId: "agent-operations",
        title: "Runtime incident follow-up",
        updatedAt: "2026-09-02T08:55:00+08:00",
        messages: [],
      },
    ],
  };
}
