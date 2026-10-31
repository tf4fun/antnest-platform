import { useState } from "react";
import {
  decodeNetworkSpec,
  type NetworkPort,
  type NetworkRule,
  type V2Spec,
} from "../lib/network-policy";
import { Button } from "./ui/button";
import { ErrorNotice } from "./ui/feedback";

export type RuleDraft = {
  action: "allow" | "deny";
  destinationType: "all" | "cidrs" | "domains";
  destinations: string;
  ports: string;
  protocol?: "tcp";
};

export type NetworkEditorDraft = {
  baseVersion: number;
  defaultAction: "allow" | "deny";
  rules: RuleDraft[];
};

export function draftFromSpec(spec: V2Spec): NetworkEditorDraft {
  return {
    baseVersion: 0,
    defaultAction: spec.default,
    rules: spec.rules.map((rule) => ({
      action: rule.action,
      destinationType: rule.cidrs?.length
        ? "cidrs"
        : rule.domains?.length
          ? "domains"
          : "all",
      destinations: (rule.cidrs ?? rule.domains ?? []).join(","),
      ports: (rule.ports ?? [])
        .map((port) =>
          typeof port === "number" ? String(port) : `${port.from}-${port.to}`,
        )
        .join(","),
      protocol: rule.protocol === "tcp" ? "tcp" : undefined,
    })),
  };
}

function parsePorts(text: string): NetworkPort[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return trimmed.split(",").map((token) => {
    const part = token.trim();
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) return { from: Number(range[1]), to: Number(range[2]) };
    const single = /^\d+$/.exec(part);
    if (single) return Number(part);
    throw new Error(`Invalid port "${part}"; use an integer or from-to`);
  });
}

function buildSpec(draft: NetworkEditorDraft): V2Spec {
  const rules: NetworkRule[] = draft.rules.map((entry) => {
    const rule: NetworkRule = { action: entry.action };
    const destinations = entry.destinations
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (entry.destinationType === "cidrs") rule.cidrs = destinations;
    if (entry.destinationType === "domains") rule.domains = destinations;
    if (destinations.length === 0 && entry.destinationType !== "all")
      throw new Error("Destinations are required for cidr/domain rules");
    const ports = parsePorts(entry.ports);
    if (ports.length > 0) rule.ports = ports;
    if (entry.protocol === "tcp") rule.protocol = "tcp";
    return rule;
  });
  const spec = decodeNetworkSpec({
    schema_version: 2,
    default: draft.defaultAction,
    rules,
  });
  if (spec.schema_version !== 2) throw new Error("Spec must be schema 2");
  return spec;
}

type Props = {
  draft: NetworkEditorDraft;
  stale: boolean;
  disabled: boolean;
  onSave: (spec: V2Spec) => Promise<boolean>;
  onCancel: () => void;
};

export function NetworkRuleEditor({
  draft,
  stale,
  disabled,
  onSave,
  onCancel,
}: Props) {
  const [rules, setRules] = useState<RuleDraft[]>(draft.rules);
  const [defaultAction, setDefaultAction] = useState(draft.defaultAction);
  const [problem, setProblem] = useState("");
  const [saving, setSaving] = useState(false);

  function update(index: number, patch: Partial<RuleDraft>) {
    setRules((current) =>
      current.map((entry, position) =>
        position === index ? { ...entry, ...patch } : entry,
      ),
    );
  }
  function move(index: number, offset: number) {
    setRules((current) => {
      const next = [...current];
      const target = index + offset;
      const moving = next[index];
      const swap = next[target];
      if (target < 0 || target >= next.length || !moving || !swap)
        return current;
      next[index] = swap;
      next[target] = moving;
      return next;
    });
  }

  async function save() {
    setProblem("");
    let spec: V2Spec;
    try {
      spec = buildSpec({ ...draft, defaultAction, rules });
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Invalid rules");
      return;
    }
    setSaving(true);
    try {
      await onSave(spec);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 grid gap-3" role="form" aria-label="Custom rules">
      <label className="grid gap-1 text-sm">
        <span className="text-xs text-muted-foreground">Default action</span>
        <select
          aria-label="Default action"
          disabled={disabled || saving}
          className="w-fit rounded border border-border bg-background px-2 py-1 text-sm"
          value={defaultAction}
          onChange={(event) =>
            setDefaultAction(event.target.value as "allow" | "deny")
          }
        >
          <option value="deny">deny</option>
          <option value="allow">allow</option>
        </select>
      </label>
      {rules.map((entry, index) => (
        <fieldset
          key={index}
          disabled={disabled || saving}
          className="grid gap-2 rounded border border-border p-3"
        >
          <legend className="text-xs text-muted-foreground">
            Rule {index + 1}
          </legend>
          <div className="flex items-center justify-end">
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Move rule ${index + 1} up`}
                disabled={index === 0 || disabled}
                onClick={() => move(index, -1)}
              >
                ↑
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Move rule ${index + 1} down`}
                disabled={index === rules.length - 1 || disabled}
                onClick={() => move(index, 1)}
              >
                ↓
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove rule ${index + 1}`}
                disabled={disabled}
                onClick={() =>
                  setRules((current) =>
                    current.filter((_, position) => position !== index),
                  )
                }
              >
                Remove rule {index + 1}
              </Button>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="grid gap-1 text-sm">
              <span className="text-xs text-muted-foreground">
                Rule {index + 1} action
              </span>
              <select
                aria-label={`Rule ${index + 1} action`}
                className="w-fit rounded border border-border bg-background px-2 py-1 text-sm"
                value={entry.action}
                onChange={(event) =>
                  update(index, {
                    action: event.target.value as "allow" | "deny",
                  })
                }
              >
                <option value="allow">allow</option>
                <option value="deny">deny</option>
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-xs text-muted-foreground">
                Rule {index + 1} destination type
              </span>
              <select
                aria-label={`Rule ${index + 1} destination type`}
                className="w-fit rounded border border-border bg-background px-2 py-1 text-sm"
                value={entry.destinationType}
                onChange={(event) =>
                  update(index, {
                    destinationType: event.target.value as
                      "all" | "cidrs" | "domains",
                  })
                }
              >
                <option value="all">all</option>
                <option value="cidrs">cidrs</option>
                <option value="domains">domains</option>
              </select>
            </label>
            <label className="grid gap-1 text-sm sm:col-span-2">
              <span className="text-xs text-muted-foreground">
                Rule {index + 1} destinations (comma-separated)
              </span>
              <input
                aria-label={`Rule ${index + 1} destinations`}
                className="rounded border border-border bg-background px-2 py-1 text-sm"
                value={entry.destinations}
                disabled={entry.destinationType === "all"}
                onChange={(event) =>
                  update(index, { destinations: event.target.value })
                }
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-xs text-muted-foreground">
                Rule {index + 1} ports (integer or from-to)
              </span>
              <input
                aria-label={`Rule ${index + 1} ports`}
                className="rounded border border-border bg-background px-2 py-1 text-sm"
                placeholder="443,400-450"
                value={entry.ports}
                onChange={(event) =>
                  update(index, { ports: event.target.value })
                }
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-xs text-muted-foreground">
                Rule {index + 1} protocol
              </span>
              <input
                aria-label={`Rule ${index + 1} protocol`}
                className="rounded border border-border bg-muted px-2 py-1 text-sm"
                value="tcp"
                readOnly
              />
            </label>
          </div>
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={rules.length >= 128 || disabled}
          onClick={() =>
            setRules((current) => [
              ...current,
              {
                action: "allow",
                destinationType: "all",
                destinations: "",
                ports: "",
              },
            ])
          }
        >
          Add rule
        </Button>
        <Button
          disabled={disabled || saving || stale}
          onClick={() => void save()}
        >
          Save custom policy
        </Button>
        <Button variant="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {stale ? (
        <ErrorNotice message="Policy changed since this draft opened. Cancel and reopen custom rules to edit the current version." />
      ) : null}
      {problem ? <ErrorNotice message={problem} /> : null}
    </div>
  );
}
