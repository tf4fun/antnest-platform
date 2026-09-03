import {
  LoaderCircle,
  Pencil,
  Power,
  RefreshCw,
  UserPlus,
  Users,
  UsersRound,
} from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  DataTable,
  MobileResourceItem,
  MobileResourceList,
  PageHeader,
  ResourceFailureNotice,
  ResourceFailurePage,
  ResourceToolbar,
  SearchField,
} from "../components/page";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { Empty, ErrorNotice, Loading, SuccessNotice } from "../components/ui/feedback";
import { CheckboxField, Field, Input, Select } from "../components/ui/input";
import { api, errorMessage } from "../lib/api";
import { dateTime } from "../lib/format";
import { resourceFailure, type ResourceFailure } from "../lib/resource-failure";
import type { Directory, DirectoryMember } from "../lib/types";

type DirectoryView = "people" | "groups";

export function DirectoryPage({
  currentUserID,
  organizationName,
  systemAdministrator,
}: {
  currentUserID: string;
  organizationName: string;
  systemAdministrator: boolean;
}) {
  const [data, setData] = useState<Directory>();
  const [loadFailure, setLoadFailure] = useState<ResourceFailure>();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<DirectoryView>("people");
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState("");
  const [editing, setEditing] = useState<DirectoryMember>();
  const [editError, setEditError] = useState("");
  const [activationTarget, setActivationTarget] = useState<DirectoryMember>();
  const [activationError, setActivationError] = useState("");
  const [pending, setPending] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");

  const load = useCallback(async () => {
    setLoadFailure(undefined);
    try {
      setData(await api.directory());
    } catch (cause) {
      setLoadFailure(resourceFailure(cause));
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = new FormData(form);
    const displayName = String(input.get("display_name") ?? "").trim();
    setPending(true);
    setCreateError("");
    setSuccessMessage("");
    try {
      await api.createLocalUser({
        email: String(input.get("email") ?? "").trim(),
        display_name: displayName,
        password: String(input.get("password") ?? ""),
        role: input.get("role") === "admin" ? "admin" : "member",
      });
      form.reset();
      setCreateOpen(false);
      setSuccessMessage(`${displayName} added to the directory.`);
      await load();
    } catch (cause) {
      setCreateError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function updateMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const input = new FormData(event.currentTarget);
    const displayName = String(input.get("display_name") ?? "").trim();
    setPending(true);
    setEditError("");
    setSuccessMessage("");
    try {
      await api.updateMembership(editing.membership.id, {
        email: String(input.get("email") ?? "").trim(),
        display_name: displayName,
        role: input.get("role") === "admin" ? "admin" : "member",
        active: input.get("active") === "on",
      });
      setEditing(undefined);
      setSuccessMessage(`${displayName} updated.`);
      await load();
    } catch (cause) {
      setEditError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function setGlobalAccess() {
    if (!activationTarget) return;
    const target = activationTarget;
    setPending(true);
    setActivationError("");
    setSuccessMessage("");
    try {
      await api.setUserActive(target.user.id, !target.user.active);
      setActivationTarget(undefined);
      setSuccessMessage(target.user.active
        ? `${target.membership.display_name} can no longer access Antnest.`
        : `${target.membership.display_name} can access Antnest again.`);
      await load();
    } catch (cause) {
      setActivationError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  if (!data) {
    if (!loadFailure) return <Loading label="Loading directory" />;
    return (
      <ResourceFailurePage
        eyebrow="Organization"
        failure={loadFailure}
        resource="Directory"
        returnHref="#overview"
        returnLabel="Back to Overview"
        onRetry={() => void load()}
      />
    );
  }

  const normalized = query.trim().toLowerCase();
  const members = data.users.filter(({ membership }) =>
    [membership.display_name, membership.email, membership.role, membership.source]
      .some((value) => value.toLowerCase().includes(normalized)),
  );
  const groups = data.groups.filter((group) =>
    [group.display_name, group.source].some((value) => value.toLowerCase().includes(normalized)),
  );
  const count = view === "people"
    ? `${members.length} of ${data.users.length} people`
    : `${groups.length} of ${data.groups.length} groups`;

  return (
    <div className="grid gap-5">
      <PageHeader
        eyebrow="Organization"
        title="Directory"
        detail={`Local accounts and externally synchronized identities for ${organizationName}.`}
        actions={(
          <Button onClick={() => { setCreateError(""); setSuccessMessage(""); setCreateOpen(true); }}>
            <UserPlus className="h-4 w-4" />
            Add local user
          </Button>
        )}
      />
      {successMessage ? <SuccessNotice message={successMessage} onDismiss={() => setSuccessMessage("")} /> : null}
      {loadFailure ? <ResourceFailureNotice failure={loadFailure} retryLabel="Refresh directory" onRetry={() => void load()} /> : null}
      <ResourceToolbar>
        <div
          className="flex items-center gap-1 rounded-md border border-border bg-white p-1"
          role="tablist"
          aria-label="Directory view"
        >
          <Button
            aria-selected={view === "people"}
            role="tab"
            size="sm"
            variant={view === "people" ? "secondary" : "ghost"}
            onClick={() => { setView("people"); setQuery(""); }}
          >
            <Users className="h-4 w-4" />
            People <span className="text-muted-foreground">{data.users.length}</span>
          </Button>
          <Button
            aria-selected={view === "groups"}
            role="tab"
            size="sm"
            variant={view === "groups" ? "secondary" : "ghost"}
            onClick={() => { setView("groups"); setQuery(""); }}
          >
            <UsersRound className="h-4 w-4" />
            Groups <span className="text-muted-foreground">{data.groups.length}</span>
          </Button>
        </div>
        <div className="flex flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-3">
          <SearchField
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={view === "people" ? "Search people" : "Search groups"}
          />
          <p className="whitespace-nowrap text-xs text-muted-foreground">{count}</p>
        </div>
      </ResourceToolbar>

      {view === "people" ? (
        members.length === 0 ? (
          <Empty title="No matching people" detail="Try a different name, email, role, or identity source." />
        ) : (
          <MemberTable
            currentUserID={currentUserID}
            members={members}
            systemAdministrator={systemAdministrator}
            onEdit={(member) => { setEditError(""); setSuccessMessage(""); setEditing(member); }}
            onSetActive={(member) => { setActivationError(""); setSuccessMessage(""); setActivationTarget(member); }}
          />
        )
      ) : groups.length === 0 ? (
        <Empty
          title="No synchronized groups"
          detail="Groups appear here when an external directory provisions them through SCIM."
        />
      ) : (
        <>
        <MobileResourceList label="Directory groups">
          {groups.map((group) => (
            <MobileResourceItem key={`${group.source}:${group.display_name}:${group.created_at}`}>
              <div className="flex min-w-0 items-start gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-blue-50 text-blue-700">
                  <UsersRound className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{group.display_name}</p>
                </div>
                <Badge value={group.active ? "active" : "inactive"} />
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-3 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Source</dt>
                  <dd className="mt-1 capitalize">{group.source}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Updated</dt>
                  <dd className="mt-1 text-xs text-muted-foreground">{dateTime(group.updated_at)}</dd>
                </div>
              </dl>
            </MobileResourceItem>
          ))}
        </MobileResourceList>
        <DataTable className="hidden md:block">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead className="border-b border-border bg-muted/60 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Group</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {groups.map((group) => (
                <tr className="transition-colors hover:bg-muted/35" key={`${group.source}:${group.display_name}:${group.created_at}`}>
                  <td className="px-3 py-3.5 font-medium">{group.display_name}</td>
                  <td className="px-3 py-3 capitalize text-muted-foreground">{group.source}</td>
                  <td className="px-3 py-3"><Badge value={group.active ? "active" : "inactive"} /></td>
                  <td className="px-3 py-3 text-muted-foreground">{dateTime(group.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>
        </>
      )}

      <CreateUserDialog
        open={createOpen}
        error={createError}
        pending={pending}
        onOpenChange={(open) => { setCreateOpen(open); if (!open) setCreateError(""); }}
        onSubmit={createUser}
      />
      <EditMembershipDialog
        member={editing}
        error={editError}
        pending={pending}
        onClose={() => { setEditing(undefined); setEditError(""); }}
        onSubmit={updateMember}
      />
      <ActivationDialog
        member={activationTarget}
        error={activationError}
        pending={pending}
        onClose={() => { setActivationTarget(undefined); setActivationError(""); }}
        onConfirm={setGlobalAccess}
      />
    </div>
  );
}

function MemberTable({
  currentUserID,
  members,
  systemAdministrator,
  onEdit,
  onSetActive,
}: {
  currentUserID: string;
  members: DirectoryMember[];
  systemAdministrator: boolean;
  onEdit: (member: DirectoryMember) => void;
  onSetActive: (member: DirectoryMember) => void;
}) {
  return (
    <>
    <MobileResourceList label="Directory people">
      {members.map((member) => {
        const { user, membership } = member;
        const status = memberAccessStatus(member);
        const canToggleUser = systemAdministrator && user.id !== currentUserID;
        return (
          <MobileResourceItem key={membership.id}>
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{membership.display_name}</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{membership.email}</p>
              </div>
              <Badge value={status} />
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Role</dt>
                <dd className="mt-1 capitalize">{membership.role}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Source</dt>
                <dd className="mt-1 capitalize">{membership.source}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-xs text-muted-foreground">Joined</dt>
                <dd className="mt-1 text-xs text-muted-foreground">{dateTime(membership.created_at)}</dd>
              </div>
            </dl>
            {membership.source === "local" || systemAdministrator ? (
              <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-border pt-3">
                {membership.source === "local" ? (
                  <Button size="sm" variant="secondary" onClick={() => onEdit(member)}>
                    <Pencil className="h-4 w-4" />
                    Edit
                  </Button>
                ) : null}
                {systemAdministrator ? (
                  canToggleUser ? (
                    <Button size="sm" variant="ghost" onClick={() => onSetActive(member)}>
                      <Power className="h-4 w-4" />
                      {user.active ? "Disable user" : "Activate user"}
                    </Button>
                  ) : (
                    <span className="inline-flex h-9 items-center rounded-md bg-muted px-3 text-xs text-muted-foreground">
                      Current account
                    </span>
                  )
                ) : null}
              </div>
            ) : null}
          </MobileResourceItem>
        );
      })}
    </MobileResourceList>
    <DataTable className="hidden md:block">
      <table className="w-full min-w-[820px] text-left text-sm">
        <thead className="border-b border-border bg-muted/60 text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Person</th>
            <th className="px-3 py-2 font-medium">Role</th>
            <th className="px-3 py-2 font-medium">Source</th>
            <th className="px-3 py-2 font-medium">Access</th>
            <th className="px-3 py-2 font-medium">Joined</th>
            <th className="px-3 py-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {members.map((member) => {
            const { user, membership } = member;
            const status = memberAccessStatus(member);
            const canToggleUser = systemAdministrator && user.id !== currentUserID;
            return (
              <tr className="transition-colors hover:bg-muted/35" key={membership.id}>
                <td className="px-3 py-3.5">
                  <p className="font-medium">{membership.display_name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{membership.email}</p>
                </td>
                <td className="px-3 py-3 capitalize">{membership.role}</td>
                <td className="px-3 py-3">
                  <span className="capitalize text-muted-foreground">{membership.source}</span>
                  {membership.source === "scim" ? (
                    <span className="ml-2 text-xs text-muted-foreground">Externally managed</span>
                  ) : null}
                </td>
                <td className="px-3 py-3"><Badge value={status} /></td>
                <td className="px-3 py-3 text-muted-foreground">{dateTime(membership.created_at)}</td>
                <td className="px-3 py-3">
                  <div className="flex justify-end gap-1">
                    {membership.source === "local" ? (
                      <Button
                        aria-label={`Edit ${membership.display_name}`}
                        title="Edit local membership"
                        size="icon"
                        variant="ghost"
                        onClick={() => onEdit(member)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    ) : null}
                    {systemAdministrator ? (
                      <Button
                        aria-label={`${user.active ? "Disable" : "Activate"} ${membership.display_name} globally`}
                        title={user.id === currentUserID
                          ? "The current system administrator cannot be disabled"
                          : `${user.active ? "Disable" : "Activate"} user globally`}
                        disabled={!canToggleUser}
                        size="icon"
                        variant="ghost"
                        onClick={() => onSetActive(member)}
                      >
                        <Power className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </DataTable>
    </>
  );
}

function memberAccessStatus({ user, membership }: DirectoryMember): string {
  if (!user.active) return "disabled";
  return membership.active ? "active" : "inactive";
}

function CreateUserDialog({
  open,
  error,
  pending,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  error: string;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Dialog
      dismissible={!pending}
      open={open}
      onOpenChange={onOpenChange}
      title="Add local user"
      description="Create an account managed by Antnest in the current organization."
    >
      <form className="grid gap-5" onSubmit={onSubmit}>
        {error ? <ErrorNotice message={error} /> : null}
        <Field label="Display name"><Input name="display_name" autoComplete="name" required /></Field>
        <Field label="Email"><Input name="email" type="email" autoComplete="email" required /></Field>
        <Field label="Initial password" hint="Use 12 to 1,024 characters. The password is write-only.">
          <Input
            name="password"
            type="password"
            minLength={12}
            maxLength={1024}
            autoComplete="new-password"
            required
          />
        </Field>
        <Field label="Organization role">
          <Select name="role" defaultValue="member">
            <option value="member">Member</option>
            <option value="admin">Administrator</option>
          </Select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button disabled={pending} type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button aria-busy={pending} disabled={pending} type="submit">
            {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
            Create user
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function EditMembershipDialog({
  member,
  error,
  pending,
  onClose,
  onSubmit,
}: {
  member?: DirectoryMember;
  error: string;
  pending: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Dialog
      dismissible={!pending}
      open={Boolean(member)}
      onOpenChange={(open) => { if (!open) onClose(); }}
      title="Edit local membership"
      description="Update this person's profile and access in the current organization."
    >
      {member ? (
        <form className="grid gap-5" key={member.membership.id} onSubmit={onSubmit}>
          {error ? <ErrorNotice message={error} /> : null}
          <Field label="Display name">
            <Input name="display_name" defaultValue={member.membership.display_name} required />
          </Field>
          <Field label="Email">
            <Input name="email" type="email" defaultValue={member.membership.email} required />
          </Field>
          <Field label="Organization role">
            <Select name="role" defaultValue={member.membership.role}>
              <option value="member">Member</option>
              <option value="admin">Administrator</option>
            </Select>
          </Field>
          <CheckboxField
            defaultChecked={member.membership.active}
            hint="Inactive members cannot use this organization. At least one active administrator must remain."
            label="Organization access"
            name="active"
          />
          <div className="flex justify-end gap-2">
            <Button disabled={pending} type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button aria-busy={pending} disabled={pending} type="submit">
              {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />}
              Save membership
            </Button>
          </div>
        </form>
      ) : null}
    </Dialog>
  );
}

function ActivationDialog({
  member,
  error,
  pending,
  onClose,
  onConfirm,
}: {
  member?: DirectoryMember;
  error: string;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      dismissible={!pending}
      open={Boolean(member)}
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={member?.user.active ? "Disable user globally" : "Activate user globally"}
      description={member?.user.active
        ? "This security action blocks the user in every organization and revokes active API tokens."
        : "Restore this user's platform access. Organization memberships keep their own active state."}
    >
      {member ? (
        <div className="grid gap-5">
          {error ? <ErrorNotice message={error} /> : null}
          <div className="rounded-md border border-border bg-muted/40 p-4">
            <p className="font-medium">{member.membership.display_name}</p>
            <p className="mt-1 text-sm text-muted-foreground">{member.membership.email}</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button disabled={pending} variant="secondary" onClick={onClose}>Cancel</Button>
            <Button
              aria-busy={pending}
              variant={member.user.active ? "destructive" : "default"}
              disabled={pending}
              onClick={onConfirm}
            >
              {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
              {member.user.active ? "Disable user" : "Activate user"}
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
