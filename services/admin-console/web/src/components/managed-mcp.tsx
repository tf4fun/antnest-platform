import { Eye, EyeOff, Plus, Terminal, Trash2, X } from "lucide-react";
import { useState } from "react";
import type { ManagedMCPServer, ManagedMCPSummary } from "../lib/types";
import { editMultiline } from "../lib/managed-mcp";
import { Button } from "./ui/button";
import { Field, Input, Textarea } from "./ui/input";

type Argument = { key: string; value: string };
type Variable = Argument & { name: string };
type Draft = { key: string; id: string; command: string; args: Argument[]; env: Variable[] };
const keyed = (value: string): Argument => ({ key: crypto.randomUUID(), value });
const textRows = (value: string) => Math.min(6, Math.max(1, value.split(/\r\n|\r|\n/).length));

function draft(server: ManagedMCPServer): Draft {
  return {
    key: crypto.randomUUID(), id: server.id, command: server.command,
    args: (server.args ?? []).map(keyed),
    env: Object.entries(server.env ?? {}).map(([name, value]) => ({ ...keyed(value), name })),
  };
}

export function ManagedMCPEditor({ initial = [], disabled = false }: { initial?: ManagedMCPServer[]; disabled?: boolean }) {
  const [servers, setServers] = useState(() => initial.map(draft));
  const value = servers.map(({ id, command, args, env }) => ({
    id, command, args: args.map((argument) => argument.value), env: env.map(({ name, value }) => ({ name, value })),
  }));
  return (
    <fieldset disabled={disabled} className="min-w-0 border-t border-border pt-4">
      <legend className="px-1 text-sm font-semibold">MCP servers</legend>
      <input type="hidden" name="managed_mcp" value={JSON.stringify(value)} />
      <div className="grid gap-5">
        {servers.length === 0 ? <p className="text-sm text-muted-foreground">No MCP servers</p> : null}
        {servers.map((server, index) => (
          <ServerEditor key={server.key} value={server} index={index}
            onChange={(next) => setServers((current) => current.map((item) => item.key === server.key ? next : item))}
            onRemove={() => setServers((current) => current.filter((item) => item.key !== server.key))} />
        ))}
        <Button className="w-fit" type="button" variant="secondary" size="sm" disabled={disabled || servers.length >= 8}
          onClick={() => setServers((current) => [...current, draft({ id: "", command: "", args: [], env: {} })])}>
          <Plus className="h-4 w-4" />Add MCP server
        </Button>
      </div>
    </fieldset>
  );
}

function ServerEditor({ value, index, onChange, onRemove }: { value: Draft; index: number; onChange: (value: Draft) => void; onRemove: () => void }) {
  return (
    <fieldset className="min-w-0 rounded-md border border-border p-3">
      <legend className="px-1 text-xs font-semibold text-muted-foreground">Server {index + 1} · stdio</legend>
      <div className="mb-3 flex items-end gap-2">
        <div className="min-w-0 flex-1"><Field label="Server ID"><Input autoComplete="off" required maxLength={16} placeholder="documents" value={value.id} onChange={(event) => onChange({ ...value, id: event.target.value })} /></Field></div>
        <IconButton label={`Remove MCP server ${index + 1}`} onClick={onRemove}><Trash2 className="h-4 w-4" /></IconButton>
      </div>
      <Field label="Command"><Textarea className="min-h-10" rows={textRows(value.command)} autoComplete="off" required placeholder="node" value={value.command} onChange={(event) => onChange({ ...value, command: editMultiline(value.command, event.target.value) })} /></Field>
      <div className="mt-4 grid gap-2">
        {value.args.map((argument, position) => (
          <div className="flex items-end gap-2" key={argument.key}>
            <div className="min-w-0 flex-1"><Field label={`Argument ${position + 1}`}><Textarea className="min-h-10" rows={textRows(argument.value)} value={argument.value} onChange={(event) => onChange({ ...value, args: value.args.map((item) => item.key === argument.key ? { ...item, value: editMultiline(item.value, event.target.value) } : item) })} /></Field></div>
            <IconButton label={`Remove argument ${position + 1}`} onClick={() => onChange({ ...value, args: value.args.filter((item) => item.key !== argument.key) })}><X className="h-4 w-4" /></IconButton>
          </div>
        ))}
        <Button type="button" size="sm" variant="ghost" className="w-fit" disabled={value.args.length >= 64} onClick={() => onChange({ ...value, args: [...value.args, keyed("")] })}><Plus className="h-4 w-4" />Add argument</Button>
      </div>
      <div className="mt-3 grid gap-3">
        {value.env.map((variable, position) => (
          <div key={variable.key} className="grid min-w-0 gap-2 border-t border-border pt-3">
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1"><Field label={`Variable ${position + 1} name`}><Input autoComplete="off" required value={variable.name} placeholder="API_KEY" onChange={(event) => onChange({ ...value, env: value.env.map((item) => item.key === variable.key ? { ...item, name: event.target.value } : item) })} /></Field></div>
              <IconButton label={`Remove variable ${position + 1}`} onClick={() => onChange({ ...value, env: value.env.filter((item) => item.key !== variable.key) })}><X className="h-4 w-4" /></IconButton>
            </div>
            <SecretValue label={`Variable ${position + 1} value`} value={variable.value} onChange={(next) => onChange({ ...value, env: value.env.map((item) => item.key === variable.key ? { ...item, value: next } : item) })} />
          </div>
        ))}
        <Button type="button" size="sm" variant="ghost" className="w-fit" disabled={value.env.length >= 64} onClick={() => onChange({ ...value, env: [...value.env, { ...keyed(""), name: "" }] })}><Plus className="h-4 w-4" />Add environment variable</Button>
      </div>
    </fieldset>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return <Button type="button" variant="ghost" size="icon" title={label} aria-label={label} onClick={onClick}>{children}</Button>;
}

function SecretValue({ label, value, onChange }: { label: string; value: string; onChange?: (value: string) => void }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="flex min-w-0 items-end gap-2">
      <div className="min-w-0 flex-1"><Field label={label}>{visible
        ? <Textarea className="min-h-10" rows={textRows(value)} autoComplete="off" readOnly={!onChange} value={value} onChange={(event) => onChange?.(editMultiline(value, event.target.value))} />
        : <Input type="password" autoComplete="new-password" readOnly value={value ? "hidden-value" : ""} title={onChange ? "Show value to edit" : "Hidden value"} />
      }</Field></div>
      <IconButton label={`${visible ? "Hide" : "Show"} ${label}`} onClick={() => setVisible(!visible)}>{visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</IconButton>
    </div>
  );
}

export function ManagedMCPDetails({ servers = [] }: { servers?: ManagedMCPServer[] }) {
  if (servers.length === 0) return <p className="text-sm text-muted-foreground">No MCP servers</p>;
  return (
    <div className="divide-y divide-border">
      {servers.map((server) => (
        <div key={server.id} className="grid min-w-0 gap-3 py-4 first:pt-0">
          <ServerSummary server={server} />
          {server.args?.length ? <ol className="grid gap-1 text-sm">{server.args.map((arg, index) => <li key={index} className="flex min-w-0 gap-3"><span className="shrink-0 text-muted-foreground">{index + 1}.</span><code className="whitespace-pre-wrap break-all">{JSON.stringify(arg)}</code></li>)}</ol> : null}
          {Object.entries(server.env ?? {}).map(([name, value]) => <SecretValue key={name} label={`${name} value`} value={value} />)}
        </div>
      ))}
    </div>
  );
}

export function ManagedMCPSummary({ servers = [] }: { servers?: ManagedMCPSummary[] }) {
  if (servers.length === 0) return <p className="text-sm text-muted-foreground">No MCP servers</p>;
  return <div className="grid gap-3">{servers.map((server) => <ServerSummary key={server.id} server={server} />)}</div>;
}

function ServerSummary({ server }: { server: ManagedMCPSummary }) {
  return <div className="flex min-w-0 items-start gap-3"><Terminal className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /><div className="min-w-0"><p className="text-sm font-medium">{server.id}</p><code className="break-all text-xs text-muted-foreground">{server.command}</code></div></div>;
}
