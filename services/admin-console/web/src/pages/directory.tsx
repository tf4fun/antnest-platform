import { useEffect, useState } from "react";
import { DataTable, PageHeader } from "../components/page";
import { Badge } from "../components/ui/badge";
import { ErrorNotice, Loading } from "../components/ui/feedback";
import { api, errorMessage } from "../lib/api";
import { dateTime, shortID } from "../lib/format";
import type { Directory } from "../lib/types";

export function DirectoryPage({ organizationID }: { organizationID: string }) {
  const [data, setData] = useState<Directory>();
  const [error, setError] = useState("");
  useEffect(() => {
    api.directory().then(setData).catch((cause: unknown) => setError(errorMessage(cause)));
  }, []);
  if (error) return <ErrorNotice message={error} />;
  if (!data) return <Loading label="Loading directory" />;
  return (
    <div className="grid gap-6">
      <PageHeader title="Directory" detail={`Organization ${shortID(organizationID)} · members resolved by Identity Service.`} />
      <DataTable>
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="bg-muted/60 text-xs text-muted-foreground">
            <tr><th className="px-3 py-2 font-medium">Member</th><th className="px-3 py-2 font-medium">Role</th><th className="px-3 py-2 font-medium">Source</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 font-medium">Joined</th><th className="px-3 py-2 font-medium">User ID</th></tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.users.map(({ user, membership }) => (
              <tr key={membership.id}>
                <td className="px-3 py-3"><p className="font-medium">{membership.display_name}</p><p className="text-xs text-muted-foreground">{membership.email}</p></td>
                <td className="px-3 py-3 capitalize">{membership.role}</td>
                <td className="px-3 py-3 capitalize text-muted-foreground">{membership.source}</td>
                <td className="px-3 py-3"><Badge value={user.active && membership.active ? "active" : "inactive"} /></td>
                <td className="px-3 py-3 text-muted-foreground">{dateTime(membership.created_at)}</td>
                <td className="px-3 py-3 font-mono text-xs text-muted-foreground" title={user.id}>{shortID(user.id)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataTable>
    </div>
  );
}
