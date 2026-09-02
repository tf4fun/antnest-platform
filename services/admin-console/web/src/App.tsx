import { Bot, Boxes, BrainCircuit, LayoutDashboard, LogOut, Menu, Users, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "./components/ui/button";
import { ErrorNotice, Loading } from "./components/ui/feedback";
import { APIError, api, errorMessage } from "./lib/api";
import type { Session } from "./lib/types";
import { cn } from "./lib/utils";
import { AgentsPage } from "./pages/agents";
import { DashboardPage } from "./pages/dashboard";
import { DirectoryPage } from "./pages/directory";
import { LoginPage } from "./pages/login";
import { ModelsPage } from "./pages/models";
import { TemplatesPage } from "./pages/templates";

type Route = { page: "overview" | "directory" | "models" | "templates" | "agents"; agentID?: string };

const navigation = [
  { page: "overview" as const, label: "Overview", icon: LayoutDashboard },
  { page: "directory" as const, label: "Directory", icon: Users },
  { page: "models" as const, label: "Models", icon: BrainCircuit },
  { page: "templates" as const, label: "Templates", icon: Boxes },
  { page: "agents" as const, label: "Agents", icon: Bot },
];

function routeFromHash(): Route {
  const parts = window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const page = parts[0];
  if (page === "directory" || page === "models" || page === "templates") return { page };
  if (page === "agents") return { page, agentID: parts[1] };
  return { page: "overview" };
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>();
  const [startupError, setStartupError] = useState("");
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    api.session().then(setSession).catch((cause: unknown) => {
      if (cause instanceof APIError && cause.status === 401) setSession(null);
      else setStartupError(errorMessage(cause));
    });
  }, []);
  useEffect(() => {
    const update = () => { setRoute(routeFromHash()); setMenuOpen(false); };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  useEffect(() => {
    const expired = () => setSession(null);
    window.addEventListener("antnest:session-expired", expired);
    return () => window.removeEventListener("antnest:session-expired", expired);
  }, []);

  if (startupError) {
    return <main className="mx-auto grid min-h-screen max-w-lg place-items-center p-6"><div className="grid w-full gap-4"><ErrorNotice message={startupError} /><Button variant="secondary" onClick={() => window.location.reload()}>Retry</Button></div></main>;
  }
  if (session === undefined) return <main className="grid min-h-screen place-items-center"><Loading label="Connecting to Antnest" /></main>;
  if (session === null) return <LoginPage onLogin={setSession} />;

  async function logout() {
    try { await api.logout(); } finally { setSession(null); }
  }

  return (
    <div className="min-h-screen bg-background text-foreground lg:grid lg:grid-cols-[224px_1fr]">
      <aside className={cn("fixed inset-y-0 left-0 z-30 flex w-56 -translate-x-full flex-col border-r border-border bg-[#132a23] text-white transition-transform lg:translate-x-0", menuOpen && "translate-x-0")}>
        <div className="flex h-16 items-center gap-3 border-b border-white/10 px-4">
          <div className="grid h-8 w-8 place-items-center rounded-md bg-emerald-300 text-xs font-bold text-[#132a23]">A</div>
          <div><p className="text-sm font-semibold">Antnest</p><p className="text-[11px] text-white/55">Administrator Console</p></div>
          <Button aria-label="Close navigation" className="ml-auto text-white hover:bg-white/10 lg:hidden" size="icon" variant="ghost" onClick={() => setMenuOpen(false)}><X className="h-4 w-4" /></Button>
        </div>
        <nav className="grid gap-1 p-3">
          {navigation.map(({ page, label, icon: Icon }) => (
            <a key={page} href={`#${page}`} className={cn("flex h-9 items-center gap-3 rounded-md px-3 text-sm text-white/70 transition-colors hover:bg-white/10 hover:text-white", route.page === page && "bg-white/12 font-medium text-white")}><Icon className="h-4 w-4" />{label}</a>
          ))}
        </nav>
        <div className="mt-auto border-t border-white/10 p-3">
          <p className="truncate px-2 text-xs font-medium">{session.principal.user_id}</p>
          <p className="mt-0.5 truncate px-2 text-[11px] text-white/50">{session.principal.system_role === "admin" ? "System administrator" : "Organization administrator"}</p>
          <Button className="mt-3 w-full justify-start text-white/70 hover:bg-white/10 hover:text-white" variant="ghost" onClick={() => void logout()}><LogOut className="h-4 w-4" />Sign out</Button>
        </div>
      </aside>
      {menuOpen ? <button className="fixed inset-0 z-20 bg-black/30 lg:hidden" aria-label="Close navigation" onClick={() => setMenuOpen(false)} /> : null}
      <div className="min-w-0 lg:col-start-2">
        <header className="sticky top-0 z-10 flex h-14 items-center border-b border-border bg-background/95 px-4 backdrop-blur lg:hidden"><Button aria-label="Open navigation" size="icon" variant="ghost" onClick={() => setMenuOpen(true)}><Menu className="h-5 w-5" /></Button><span className="ml-2 text-sm font-semibold">Antnest</span></header>
        <main className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {route.page === "overview" ? <DashboardPage /> : null}
          {route.page === "directory" ? <DirectoryPage organizationID={session.principal.organization_id} /> : null}
          {route.page === "models" ? <ModelsPage /> : null}
          {route.page === "templates" ? <TemplatesPage /> : null}
          {route.page === "agents" ? <AgentsPage agentID={route.agentID} /> : null}
        </main>
      </div>
    </div>
  );
}
