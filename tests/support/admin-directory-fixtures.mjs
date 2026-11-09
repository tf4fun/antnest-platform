import { createHash } from "node:crypto";
import { validateGolden } from "./contracts/golden.mjs";

const MEMBER_RESPONSE =
  "admin-console/admin-api.ids-v2.schema.json#/$defs/directory_members_response";
const GROUP_RESPONSE =
  "admin-console/admin-api.ids-v2.schema.json#/$defs/directory_groups_response";
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const MAX_CURSOR = 4096;
const MAX_PREFIX = 256;

const USER_FIELDS = ["id", "system_role", "active", "created_at", "updated_at"];
const MEMBERSHIP_FIELDS = [
  "id",
  "user_id",
  "email",
  "display_name",
  "role",
  "source",
  "active",
  "created_at",
  "updated_at",
];
const GROUP_FIELDS = [
  "display_name",
  "source",
  "active",
  "created_at",
  "updated_at",
];

const pick = (record, fields) => {
  const projected = {};
  for (const field of fields) projected[field] = record?.[field];
  return projected;
};

const scopeFor = (kind, filter, snapshot) =>
  createHash("sha256")
    .update(`${kind}\n${JSON.stringify(filter)}\n${JSON.stringify(snapshot)}`)
    .digest("hex");

const encodeCursor = (kind, offset, scope) =>
  Buffer.from(JSON.stringify({ v: 1, kind, offset, scope })).toString(
    "base64url",
  );

const decodeCursor = (value, kind, scope, maximum) => {
  if (value === "" || value.length > MAX_CURSOR)
    throw new Error("cursor is invalid");
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("cursor is invalid");
  }
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    decoded.v !== 1 ||
    decoded.kind !== kind ||
    decoded.scope !== scope ||
    !Number.isInteger(decoded.offset) ||
    decoded.offset < 0 ||
    decoded.offset > maximum ||
    Object.keys(decoded).some(
      (key) => !["v", "kind", "offset", "scope"].includes(key),
    ) ||
    encodeCursor(decoded.kind, decoded.offset, decoded.scope) !== value
  ) {
    throw new Error("cursor is invalid");
  }
  return decoded.offset;
};

const decodeQuery = (url, allowed) => {
  const query = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  const parameters = new Map();
  if (query !== "") {
    for (const pair of query.split("&")) {
      const separator = pair.indexOf("=");
      const rawKey = separator === -1 ? pair : pair.slice(0, separator);
      const rawValue = separator === -1 ? "" : pair.slice(separator + 1);
      const key = decodeURIComponent(rawKey.replaceAll("+", " "));
      const value = decodeURIComponent(rawValue.replaceAll("+", " "));
      if (parameters.has(key))
        throw new Error(`query parameter ${key} is repeated`);
      parameters.set(key, value);
    }
  }
  for (const key of parameters.keys()) {
    if (!allowed.has(key))
      throw new Error(`query parameter ${key} is not allowed`);
  }
  return parameters;
};

const parseLimit = (parameters) => {
  const raw = parameters.get("limit");
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) throw new Error("limit is invalid");
  const limit = Number(raw);
  if (limit < 1 || limit > MAX_LIMIT) throw new Error("limit is invalid");
  return limit;
};

const parseActive = (parameters) => {
  const raw = parameters.get("active");
  if (raw === undefined) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error("active is invalid");
};

const parseEnum = (parameters, key, values) => {
  const raw = parameters.get(key);
  if (raw === undefined) return undefined;
  if (!values.includes(raw)) throw new Error(`${key} is invalid`);
  return raw;
};

const parsePrefix = (parameters) => {
  const raw = parameters.get("q");
  if (raw === undefined) return "";
  const prefix = raw.trim().toLowerCase();
  if (Buffer.byteLength(prefix) > MAX_PREFIX) {
    throw new Error("q is invalid");
  }
  return prefix;
};

export function createDirectoryFixture(directory) {
  const snapshot = structuredClone(directory);
  const users = snapshot.users ?? [];
  const groups = snapshot.groups ?? [];
  const members = users
    .map((member, index) => ({ member, index }))
    .sort((left, right) => {
      const email = Buffer.compare(
        Buffer.from(left.member.membership.email ?? ""),
        Buffer.from(right.member.membership.email ?? ""),
      );
      if (email !== 0) return email;
      return Buffer.compare(
        Buffer.from(left.member.membership.id ?? ""),
        Buffer.from(right.member.membership.id ?? ""),
      );
    });
  const orderedGroups = groups
    .map((group, index) => ({ group, index }))
    .sort((left, right) => {
      const name = Buffer.compare(
        Buffer.from(left.group.display_name ?? ""),
        Buffer.from(right.group.display_name ?? ""),
      );
      return name !== 0 ? name : left.index - right.index;
    });

  const serve = async (url) => {
    const membersPath = url.pathname === "/api/admin/directory/members";
    const groupsPath = url.pathname === "/api/admin/directory/groups";
    if (!membersPath && !groupsPath)
      throw new Error(`unexpected directory path ${url.pathname}`);
    const kind = membersPath ? "members" : "groups";
    const allowed = membersPath
      ? new Set(["cursor", "limit", "q", "role", "active", "source"])
      : new Set(["cursor", "limit", "q", "active", "source"]);
    const parameters = decodeQuery(url, allowed);
    const limit = parseLimit(parameters);
    const filter = {};
    if (membersPath) {
      const role = parseEnum(parameters, "role", ["admin", "member"]);
      if (role !== undefined) filter.role = role;
      const prefix = parsePrefix(parameters);
      if (prefix !== "") filter.email_prefix = prefix;
    } else {
      const prefix = parsePrefix(parameters);
      if (prefix !== "") filter.display_name_prefix = prefix;
    }
    const active = parseActive(parameters);
    if (active !== undefined) filter.active = active;
    const source = parseEnum(parameters, "source", ["local", "scim"]);
    if (source !== undefined) filter.source = source;
    const scope = scopeFor(kind, filter, snapshot);
    const filtered = membersPath
      ? members.filter(({ member }) => {
          const membership = member.membership;
          const effective =
            Boolean(member.user?.active) && Boolean(membership?.active);
          if (filter.active !== undefined && effective !== filter.active)
            return false;
          if (filter.role !== undefined && membership?.role !== filter.role)
            return false;
          if (
            filter.source !== undefined &&
            membership?.source !== filter.source
          )
            return false;
          if (
            filter.email_prefix !== undefined &&
            !(membership?.email ?? "")
              .toLowerCase()
              .startsWith(filter.email_prefix)
          )
            return false;
          return true;
        })
      : orderedGroups.filter(({ group }) => {
          if (
            filter.active !== undefined &&
            Boolean(group.active) !== filter.active
          )
            return false;
          if (filter.source !== undefined && group.source !== filter.source)
            return false;
          if (
            filter.display_name_prefix !== undefined &&
            !(group.display_name ?? "")
              .toLowerCase()
              .startsWith(filter.display_name_prefix)
          ) {
            return false;
          }
          return true;
        });
    const cursor = parameters.get("cursor");
    const offset =
      cursor === undefined
        ? 0
        : decodeCursor(cursor, kind, scope, filtered.length);
    const slice = filtered.slice(offset, offset + limit);
    const hasMore = offset + limit < filtered.length;
    const page = membersPath
      ? {
          items: slice.map(({ member }) => ({
            user: pick(member.user, USER_FIELDS),
            membership: pick(member.membership, MEMBERSHIP_FIELDS),
          })),
          next_cursor: hasMore
            ? encodeCursor(kind, offset + limit, scope)
            : null,
        }
      : {
          items: slice.map(({ group }) => pick(group, GROUP_FIELDS)),
          next_cursor: hasMore
            ? encodeCursor(kind, offset + limit, scope)
            : null,
        };
    await validateGolden(membersPath ? MEMBER_RESPONSE : GROUP_RESPONSE, page);
    return page;
  };
  return serve;
}
