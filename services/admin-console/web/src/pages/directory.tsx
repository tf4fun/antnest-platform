import {
  LoaderCircle,
  Link2,
  Monitor,
  Pencil,
  Power,
  RefreshCw,
  UserPlus,
  Users,
  UsersRound,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  DataTable,
  MobileResourceItem,
  MobileResourceList,
  PageHeader,
  ResourceFailureNotice,
  ResourceToolbar,
  SearchField,
} from "../components/page";
import { Badge } from "../components/ui/badge";
import { SessionManagement } from "../components/session-management";
import { OrganizationExternalIdentities } from "../components/external-identities";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { Empty, ErrorNotice, Loading, SuccessNotice } from "../components/ui/feedback";
import { CheckboxField, Field, Input, Select } from "../components/ui/input";
import { api, errorMessage } from "../lib/api";
import { dateTime } from "../lib/format";
import { resourceFailure, type ResourceFailure } from "../lib/resource-failure";
import type {
  DirectoryGroup,
  DirectoryGroupQuery,
  DirectoryMember,
  DirectoryMemberQuery,
} from "../lib/types";

type DirectoryView = "people" | "groups";

type MemberListState = {
  items: DirectoryMember[];
  nextCursor: string | null | undefined;
  pending: boolean;
  failure?: ResourceFailure;
  continuationFailure?: ResourceFailure;
};

type GroupListState = {
  items: DirectoryGroup[];
  nextCursor: string | null | undefined;
  pending: boolean;
  failure?: ResourceFailure;
  continuationFailure?: ResourceFailure;
};

export function DirectoryPage({
  currentUserID,
  organizationName,
  systemAdministrator,
}: {
  currentUserID: string;
  organizationName: string;
  systemAdministrator: boolean;
}) {
  const [memberState, setMemberState] = useState<MemberListState>({
    items: [], nextCursor: undefined, pending: false,
  });
  const [groupState, setGroupState] = useState<GroupListState>({
    items: [], nextCursor: undefined, pending: false,
  });
  const [memberQuery, setMemberQuery] = useState<DirectoryMemberQuery>({});
  const [groupQuery, setGroupQuery] = useState<DirectoryGroupQuery>({});
  const memberGeneration = useRef(0);
  const groupGeneration = useRef(0);
  const memberAbort = useRef<AbortController | undefined>(undefined);
  const groupAbort = useRef<AbortController | undefined>(undefined);
  const memberReadLocked = useRef(false);
  const groupReadLocked = useRef(false);
  const groupLoadedQuery = useRef<string | undefined>(undefined);
  const memberSentinel = useRef<HTMLDivElement>(null);
  const groupSentinel = useRef<HTMLDivElement>(null);
  const loadPending = memberState.pending && memberState.nextCursor === undefined;
  const loadFailure = memberState.nextCursor === undefined ? memberState.failure : undefined;
  const [query, setQuery] = useState("");
  const [view, setView] = useState<DirectoryView>("people");
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState("");
  const [editing, setEditing] = useState<DirectoryMember>();
  const [sessionTarget, setSessionTarget] = useState<DirectoryMember>();
  const [externalIdentityTarget, setExternalIdentityTarget] = useState<DirectoryMember>();
  const [editError, setEditError] = useState("");
  const [activationTarget, setActivationTarget] = useState<DirectoryMember>();
  const [activationError, setActivationError] = useState("");
  const [pending, setPending] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");

  const fetchMembers = useCallback(async (cursor?: string, reset = false) => {
    if (cursor !== undefined && memberReadLocked.current) return;
    const generation = ++memberGeneration.current;
    memberAbort.current?.abort();
    const controller = new AbortController();
    memberAbort.current = controller;
    memberReadLocked.current = true;
    if (reset) {
      setMemberState({ items: [], nextCursor: undefined, pending: true });
    } else {
      setMemberState((current) => ({
        ...current,
        nextCursor: cursor === undefined ? undefined : current.nextCursor,
        pending: true,
        continuationFailure: undefined,
      }));
    }
    try {
      const page = await api.directoryMembers(
        cursor === undefined ? memberQuery : { ...memberQuery, cursor },
        controller.signal,
      );
      if (generation !== memberGeneration.current) return;
      setMemberState((current) => ({
        items: cursor === undefined
          ? page.items
          : [...current.items, ...page.items.filter(
              (item) => !current.items.some((known) => known.membership.id === item.membership.id))],
        nextCursor: page.next_cursor,
        pending: false,
        failure: undefined,
        continuationFailure: undefined,
      }));
    } catch (cause) {
      if (generation !== memberGeneration.current) return;
      setMemberState((current) => cursor === undefined
        ? { ...current, pending: false, failure: resourceFailure(cause) }
        : { ...current, pending: false, continuationFailure: resourceFailure(cause) });
    } finally {
      if (generation === memberGeneration.current) memberReadLocked.current = false;
    }
  }, [memberQuery]);

  const fetchGroups = useCallback(async (cursor?: string, reset = false) => {
    if (cursor !== undefined && groupReadLocked.current) return;
    const generation = ++groupGeneration.current;
    groupAbort.current?.abort();
    const controller = new AbortController();
    groupAbort.current = controller;
    groupReadLocked.current = true;
    if (reset) {
      setGroupState({ items: [], nextCursor: undefined, pending: true });
    } else {
      setGroupState((current) => ({
        ...current,
        nextCursor: cursor === undefined ? undefined : current.nextCursor,
        pending: true,
        continuationFailure: undefined,
      }));
    }
    try {
      const page = await api.directoryGroups(
        cursor === undefined ? groupQuery : { ...groupQuery, cursor },
        controller.signal,
      );
      if (generation !== groupGeneration.current) return;
      setGroupState((current) => ({
        items: cursor === undefined ? page.items : [...current.items, ...page.items],
        nextCursor: page.next_cursor,
        pending: false,
        failure: undefined,
        continuationFailure: undefined,
      }));
    } catch (cause) {
      if (generation !== groupGeneration.current) return;
      setGroupState((current) => cursor === undefined
        ? { ...current, pending: false, failure: resourceFailure(cause) }
        : { ...current, pending: false, continuationFailure: resourceFailure(cause) });
    } finally {
      if (generation === groupGeneration.current) groupReadLocked.current = false;
    }
  }, [groupQuery]);

  const load = useCallback(async () => {
    await fetchMembers(undefined, false);
  }, [fetchMembers]);

  useEffect(() => void fetchMembers(undefined, true), [fetchMembers]);

  const groupQueryKey = JSON.stringify(groupQuery);
  useEffect(() => {
    if (view !== "groups" || groupLoadedQuery.current === groupQueryKey) return;
    groupLoadedQuery.current = groupQueryKey;
    void fetchGroups(undefined, true);
  }, [view, groupQueryKey, fetchGroups]);

  useEffect(() => () => {
    memberAbort.current?.abort();
    groupAbort.current?.abort();
    memberGeneration.current += 1;
    groupGeneration.current += 1;
  }, []);

  useEffect(() => {
    const sentinel = memberSentinel.current;
    if (view !== "people" || !sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) &&
          memberState.nextCursor && !memberState.pending && !memberState.continuationFailure) {
        void fetchMembers(memberState.nextCursor);
      }
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [view, memberState.nextCursor, memberState.pending, memberState.continuationFailure, fetchMembers]);

  useEffect(() => {
    const sentinel = groupSentinel.current;
    if (view !== "groups" || !sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) &&
          groupState.nextCursor && !groupState.pending && !groupState.continuationFailure) {
        void fetchGroups(groupState.nextCursor);
      }
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [view, groupState.nextCursor, groupState.pending, groupState.continuationFailure, fetchGroups]);

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || loadPending) return;
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
    if (!editing || pending || loadPending || loadFailure) return;
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
    if (!activationTarget || pending || loadPending || loadFailure) return;
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

  const members = memberState.items;
  const groups = groupState.items;
  const peopleCount = memberState.nextCursor ? `${members.length}+ people` : `${members.length} people`;
  const groupCount = groupState.nextCursor === undefined
    ? `${groups.length} groups`
    : groupState.nextCursor ? `${groups.length}+ groups` : `${groups.length} groups`;
  const count = view === "people" ? peopleCount : groupCount;

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prefix = query.trim().toLowerCase();
    if (view === "people") {
      setMemberQuery((current) => {
        const next = { ...current };
        if (prefix === "") delete next.q; else next.q = prefix;
        return next;
      });
    } else {
      setGroupQuery((current) => {
        const next = { ...current };
        if (prefix === "") delete next.q; else next.q = prefix;
        return next;
      });
    }
  }

  function updateMemberFilter(field: "role" | "active" | "source", value: string) {
    setMemberQuery((current) => {
      const next = { ...current };
      if (field === "role") {
        if (value === "") delete next.role; else next.role = value as DirectoryMemberQuery["role"];
      } else if (field === "active") {
        if (value === "") delete next.active; else next.active = value === "true";
      } else {
        if (value === "") delete next.source; else next.source = value as DirectoryMemberQuery["source"];
      }
      return next;
    });
  }

  function updateGroupFilter(field: "active" | "source", value: string) {
    setGroupQuery((current) => {
      const next = { ...current };
      if (field === "active") {
        if (value === "") delete next.active; else next.active = value === "true";
      } else {
        if (value === "") delete next.source; else next.source = value as DirectoryGroupQuery["source"];
      }
      return next;
    });
  }

  return (
    <div className="grid gap-5">
      <PageHeader
        eyebrow="Organization"
        title="Directory"
        detail={`Local accounts and externally synchronized identities for ${organizationName}.`}
        actions={(
          <Button disabled={pending || loadPending} onClick={() => { setCreateError(""); setSuccessMessage(""); setCreateOpen(true); }}>
            <UserPlus className="h-4 w-4" />
            Add local user
          </Button>
        )}
      />
      {successMessage ? <SuccessNotice message={successMessage} onDismiss={() => setSuccessMessage("")} /> : null}
      {loadFailure ? <ResourceFailureNotice failure={loadFailure} message={`${loadFailure.message} Displayed records may be out of date; member changes are unavailable.`} pending={loadPending} retryLabel="Refresh directory" onRetry={() => void load()} /> : null}
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
            onClick={() => { setView("people"); setQuery(memberQuery.q ?? ""); }}
          >
            <Users className="h-4 w-4" />
            People <span className="text-muted-foreground">{members.length}</span>
          </Button>
          <Button
            aria-selected={view === "groups"}
            role="tab"
            size="sm"
            variant={view === "groups" ? "secondary" : "ghost"}
            onClick={() => { setView("groups"); setQuery(groupQuery.q ?? ""); }}
          >
            <UsersRound className="h-4 w-4" />
            Groups <span className="text-muted-foreground">{groups.length}</span>
          </Button>
        </div>
        <div className="flex flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-3">
          <form role="search" onSubmit={submitSearch}>
            <SearchField
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={view === "people" ? "Search people" : "Search groups"}
            />
          </form>
          {view === "people" ? (
            <>
              <Select
                aria-label="Filter by role"
                value={memberQuery.role ?? ""}
                onChange={(event) => updateMemberFilter("role", event.target.value)}
              >
                <option value="">All roles</option>
                <option value="member">Member</option>
                <option value="admin">Administrator</option>
              </Select>
              <Select
                aria-label="Filter by access"
                value={memberQuery.active === undefined ? "" : String(memberQuery.active)}
                onChange={(event) => updateMemberFilter("active", event.target.value)}
              >
                <option value="">Any access</option>
                <option value="true">Active</option>
                <option value="false">Inactive</option>
              </Select>
              <Select
                aria-label="Filter by source"
                value={memberQuery.source ?? ""}
                onChange={(event) => updateMemberFilter("source", event.target.value)}
              >
                <option value="">All sources</option>
                <option value="local">Local</option>
                <option value="scim">SCIM</option>
              </Select>
            </>
          ) : (
            <>
              <Select
                aria-label="Filter by access"
                value={groupQuery.active === undefined ? "" : String(groupQuery.active)}
                onChange={(event) => updateGroupFilter("active", event.target.value)}
              >
                <option value="">Any access</option>
                <option value="true">Active</option>
                <option value="false">Inactive</option>
              </Select>
              <Select
                aria-label="Filter by source"
                value={groupQuery.source ?? ""}
                onChange={(event) => updateGroupFilter("source", event.target.value)}
              >
                <option value="">All sources</option>
                <option value="local">Local</option>
                <option value="scim">SCIM</option>
              </Select>
            </>
          )}
          <p className="whitespace-nowrap text-xs text-muted-foreground">{count}</p>
        </div>
      </ResourceToolbar>

      {view === "people" ? (
        <>
          {memberState.nextCursor === undefined && memberState.pending && members.length === 0 ? (
            <Loading label="Loading directory" />
          ) : members.length === 0 && memberState.failure ? null : members.length === 0 ? (
            <Empty title="No matching people" detail="Try a different name, email, role, or identity source." />
          ) : (
            <MemberTable
              currentUserID={currentUserID}
              members={members}
              actionsDisabled={pending || memberState.pending || Boolean(loadFailure)}
              systemAdministrator={systemAdministrator}
              onEdit={(member) => { setEditError(""); setSuccessMessage(""); setEditing(member); }}
              onSetActive={(member) => { setActivationError(""); setSuccessMessage(""); setActivationTarget(member); }}
              onSessions={setSessionTarget}
              onExternalLogins={setExternalIdentityTarget}
            />
          )}
          {memberState.continuationFailure ? (
            <ResourceFailureNotice
              failure={memberState.continuationFailure}
              message={`More people could not be loaded: ${memberState.continuationFailure.message}`}
              pending={memberState.pending}
              retryLabel="Retry"
              onRetry={() => {
                const cursor = memberState.nextCursor;
                if (cursor) void fetchMembers(cursor);
              }}
            />
          ) : null}
          <div ref={memberSentinel} aria-hidden="true" />
          {memberState.nextCursor ? (
            <div className="flex justify-center">
              <Button
                disabled={memberState.pending}
                onClick={() => {
                  const cursor = memberState.nextCursor;
                  if (cursor) void fetchMembers(cursor);
                }}
              >
                {memberState.pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
                Load more
              </Button>
            </div>
          ) : null}
        </>
      ) : groupState.nextCursor === undefined && groupState.pending && groups.length === 0 ? (
        <Loading label="Loading groups" />
      ) : groups.length === 0 && groupState.failure ? (
        <ResourceFailureNotice
          failure={groupState.failure}
          message={`Groups could not be loaded: ${groupState.failure.message}`}
          pending={groupState.pending}
          retryLabel="Retry"
          onRetry={() => void fetchGroups()}
        />
      ) : groups.length === 0 ? (
        <Empty
          title="No synchronized groups"
          detail="Groups appear here when an external directory provisions them through SCIM."
        />
      ) : (
        <>
        <MobileResourceList label="Directory groups">
          {groups.map((group, index) => (
            <MobileResourceItem key={`${index}:${group.source}:${group.display_name}:${group.created_at}`}>
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
              {groups.map((group, index) => (
                <tr className="transition-colors hover:bg-muted/35" key={`${index}:${group.source}:${group.display_name}:${group.created_at}`}>
                  <td className="px-3 py-3.5 font-medium">{group.display_name}</td>
                  <td className="px-3 py-3 capitalize text-muted-foreground">{group.source}</td>
                  <td className="px-3 py-3"><Badge value={group.active ? "active" : "inactive"} /></td>
                  <td className="px-3 py-3 text-muted-foreground">{dateTime(group.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>
        {groupState.continuationFailure ? (
          <ResourceFailureNotice
            failure={groupState.continuationFailure}
            message={`More groups could not be loaded: ${groupState.continuationFailure.message}`}
            pending={groupState.pending}
            retryLabel="Retry"
            onRetry={() => {
              const cursor = groupState.nextCursor;
              if (cursor) void fetchGroups(cursor);
            }}
          />
        ) : null}
        <div ref={groupSentinel} aria-hidden="true" />
        {groupState.nextCursor ? (
          <div className="flex justify-center">
            <Button
              disabled={groupState.pending}
              onClick={() => {
                const cursor = groupState.nextCursor;
                if (cursor) void fetchGroups(cursor);
              }}
            >
              {groupState.pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
              Load more
            </Button>
          </div>
        ) : null}
        </>
      )}

      <CreateUserDialog
        open={createOpen}
        error={createError}
        pending={pending}
        onOpenChange={(open) => { setCreateOpen(open); if (!open) setCreateError(""); }}
        onSubmit={createUser}
      />
      <SessionManagement open={Boolean(sessionTarget)} onOpenChange={open => { if (!open) setSessionTarget(undefined); }}
        user={sessionTarget ? { id: sessionTarget.user.id, name: sessionTarget.membership.display_name, current: sessionTarget.user.id === currentUserID } : undefined}
        organizationName={organizationName} />
      {externalIdentityTarget ? <OrganizationExternalIdentities key={externalIdentityTarget.membership.id}
        membership={{ id: externalIdentityTarget.membership.id, name: externalIdentityTarget.membership.display_name }} onClose={() => setExternalIdentityTarget(undefined)} /> : null}
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
  actionsDisabled,
  systemAdministrator,
  onEdit,
  onSetActive,
  onSessions,
  onExternalLogins,
}: {
  currentUserID: string;
  members: DirectoryMember[];
  actionsDisabled: boolean;
  systemAdministrator: boolean;
  onEdit: (member: DirectoryMember) => void;
  onSetActive: (member: DirectoryMember) => void;
  onSessions: (member: DirectoryMember) => void;
  onExternalLogins: (member: DirectoryMember) => void;
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
              <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-border pt-3">
                <Button aria-label={`Manage ${membership.display_name} external logins`} disabled={actionsDisabled} size="sm" variant="secondary" onClick={() => onExternalLogins(member)}>
                  <Link2 className="h-4 w-4" />External logins
                </Button>
                <Button aria-label={`Manage ${membership.display_name} browser sessions`} disabled={actionsDisabled} size="sm" variant="secondary" onClick={() => onSessions(member)}>
                  <Monitor className="h-4 w-4" />Sessions
                </Button>
                {membership.source === "local" ? (
                  <Button disabled={actionsDisabled} size="sm" variant="secondary" onClick={() => onEdit(member)}>
                    <Pencil className="h-4 w-4" />
                    Edit
                  </Button>
                ) : null}
                {systemAdministrator ? (
                  canToggleUser ? (
                    <Button disabled={actionsDisabled} size="sm" variant="ghost" onClick={() => onSetActive(member)}>
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
                    <Button aria-label={`Manage ${membership.display_name} external logins`} title="Manage external logins" disabled={actionsDisabled} size="icon" variant="ghost" onClick={() => onExternalLogins(member)}>
                      <Link2 className="h-4 w-4" />
                    </Button>
                    <Button aria-label={`Manage ${membership.display_name} browser sessions`} title="Manage browser sessions" disabled={actionsDisabled} size="icon" variant="ghost" onClick={() => onSessions(member)}>
                      <Monitor className="h-4 w-4" />
                    </Button>
                    {membership.source === "local" ? (
                      <Button
                        aria-label={`Edit ${membership.display_name}`}
                        title="Edit local membership"
                        disabled={actionsDisabled}
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
                        disabled={actionsDisabled || !canToggleUser}
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
