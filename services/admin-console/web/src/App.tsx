import {
  Bot,
  Boxes,
  BrainCircuit,
  ChevronRight,
  LayoutDashboard,
  KeyRound,
  LoaderCircle,
  LogOut,
  Menu,
  MessageSquareText,
  RefreshCw,
  ShieldCheck,
  Waypoints,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Brand } from "./components/brand";
import { AccountSecurity } from "./components/account-security";
import { ResourceFailurePage } from "./components/page";
import { Button } from "./components/ui/button";
import { ErrorNotice, Loading } from "./components/ui/feedback";
import { APIError, api, errorMessage, resetSessionRequests } from "./lib/api";
import { accountPresentation } from "./lib/account";
import { captureResource, type ResourceState } from "./lib/resource-state";
import { resourceFailure, type ResourceFailure } from "./lib/resource-failure";
import { parseConsoleRoute } from "./lib/routes";
import type { ConsolePage as Page, ConsoleRoute as Route } from "./lib/routes";
import { sessionDestination } from "./lib/session-destination";
import type { CurrentAccount, Session } from "./lib/types";
import { cn } from "./lib/utils";
import { AgentsPage } from "./pages/agents";
import { DashboardPage } from "./pages/dashboard";
import { DirectoryPage } from "./pages/directory";
import { LoginPage } from "./pages/login";
import { ModelsPage } from "./pages/models";
import { ProvisioningPage } from "./pages/provisioning";
import { TemplatesPage } from "./pages/templates";

type NavigationItem = { page: Page; label: string; icon: LucideIcon };
type NavigationGroup = { label: string; items: NavigationItem[] };

const navigation: NavigationGroup[] = [
  {
    label: "Fleet",
    items: [
      { page: "overview", label: "Overview", icon: LayoutDashboard },
      { page: "agents", label: "Agents", icon: Bot },
    ],
  },
  {
    label: "Configuration",
    items: [
      { page: "models", label: "Model providers", icon: BrainCircuit },
      { page: "templates", label: "Agent templates", icon: Boxes },
    ],
  },
  {
    label: "Organization",
    items: [
      { page: "directory", label: "Directory", icon: Users },
      { page: "provisioning", label: "Provisioning", icon: Waypoints },
    ],
  },
];

const pageLabels: Record<Page, string> = {
  overview: "Overview",
  directory: "Directory",
  provisioning: "Provisioning",
  models: "Model providers",
  templates: "Agent templates",
  agents: "Agents",
};

function Navigation({ route, onNavigate }: { route: Route; onNavigate: () => void }) {
  return (
    <nav aria-label="Primary navigation" className="flex-1 overflow-y-auto px-3 py-5">
      <div className="space-y-6">
        {navigation.map((group) => (
          <section key={group.label}>
            <h2 className="mb-2 px-3 text-[11px] font-semibold text-muted-foreground">{group.label}</h2>
            <div className="space-y-1">
              {group.items.map(({ page, label, icon: Icon }) => {
                const active = route.page === page;
                return (
                  <a
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "group flex h-10 items-center gap-3 rounded-md px-3 text-sm text-muted-foreground transition-colors",
                      active
                        ? "bg-[#e3e3de] font-medium text-foreground shadow-[inset_3px_0_#759900]"
                        : "hover:bg-muted hover:text-foreground",
                    )}
                    href={`#${page}`}
                    key={page}
                    onClick={onNavigate}
                  >
                    <Icon
                      className={cn(
                        "h-4 w-4 shrink-0",
                        active ? "text-[#667f00]" : "text-[#8a8a84] group-hover:text-foreground",
                      )}
                      aria-hidden="true"
                    />
                    <span className="truncate">{label}</span>
                  </a>
                );
              })}
            </div>
          </section>
        ))}
        <section>
          <h2 className="mb-2 px-3 text-[11px] font-semibold text-muted-foreground">Applications</h2>
          <a
            className="group flex h-10 items-center gap-3 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            href="/workspace/"
            onClick={onNavigate}
          >
            <MessageSquareText className="h-4 w-4 shrink-0 text-[#8a8a84] group-hover:text-foreground" aria-hidden="true" />
            <span className="truncate">Agent workspace</span>
          </a>
        </section>
      </div>
    </nav>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>();
  const [startupFailure, setStartupFailure] = useState<ResourceFailure>();
  const [startupPending, setStartupPending] = useState(true);
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [route, setRoute] = useState<Route>(() => parseConsoleRoute(window.location.hash));
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountSecurityOpen, setAccountSecurityOpen] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const logoutRequest = useRef<symbol | undefined>(undefined);
  const [accountState, setAccountState] = useState<ResourceState<CurrentAccount>>({ status: "loading" });
  const [accountReload, setAccountReload] = useState(0);
  const [compactNavigation, setCompactNavigation] = useState(
    () => window.matchMedia("(max-width: 1023px)").matches,
  );
  const mainContentRef = useRef<HTMLElement>(null);
  const routeReadyRef = useRef(false);

  const endSession = useCallback(() => {
    resetSessionRequests();
    logoutRequest.current = undefined;
    setLogoutPending(false);
    setLogoutError("");
    setMenuOpen(false);
    setAccountSecurityOpen(false);
    setSession(null);
  }, []);

  const startSession = useCallback((result: Session) => {
    resetSessionRequests();
    setSession(result);
  }, []);

  useEffect(() => {
    let active = true;
    void api.session().then((result) => {
      if (!active) return;
      setStartupFailure(undefined);
      startSession(result);
    }).catch((cause: unknown) => {
      if (!active) return;
      if (cause instanceof APIError && cause.status === 401) {
        setStartupFailure(undefined);
        endSession();
      } else {
        setStartupFailure(resourceFailure(cause));
      }
    }).finally(() => {
      if (active) setStartupPending(false);
    });
    return () => { active = false; };
  }, [endSession, startSession, startupAttempt]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const update = () => {
      setCompactNavigation(query.matches);
      if (!query.matches) setMenuOpen(false);
    };
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!routeReadyRef.current) {
      routeReadyRef.current = true;
      return;
    }
    window.scrollTo({ left: 0, top: 0 });
    const frame = window.requestAnimationFrame(() => {
      mainContentRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [route]);

  useEffect(() => {
    const update = () => {
      setRoute(parseConsoleRoute(window.location.hash));
      setMenuOpen(false);
    };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);

  useEffect(() => {
    window.addEventListener("antnest:session-expired", endSession);
    return () => window.removeEventListener("antnest:session-expired", endSession);
  }, [endSession]);

  useEffect(() => {
    if (!session || !(
      session.principal.system_role === "admin" ||
      session.principal.organization_role === "admin"
    )) {
      setAccountState({ status: "loading" });
      return;
    }
    let disposed = false;
    setAccountState({ status: "loading" });
    void captureResource(async () => (await api.currentAccount()).account).then((state) => {
      if (!disposed) setAccountState(state);
    });
    return () => { disposed = true; };
  }, [accountReload, session]);

  useEffect(() => {
    if (!menuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => {
      document.getElementById("close-primary-navigation")?.focus();
    }, 0);
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        window.setTimeout(() => {
          document.getElementById("open-primary-navigation")?.focus();
        }, 0);
      }
    };
    document.addEventListener("keydown", close);
    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", close);
    };
  }, [menuOpen]);

  function closeMenuToTrigger() {
    setMenuOpen(false);
    window.setTimeout(() => {
      document.getElementById("open-primary-navigation")?.focus();
    }, 0);
  }

  function closeMenuToContent() {
    setMenuOpen(false);
    window.setTimeout(() => mainContentRef.current?.focus({ preventScroll: true }), 0);
  }

  const destination = session
    ? sessionDestination(session, new URLSearchParams(window.location.search).get("return_to"))
    : undefined;
  useEffect(() => {
    if (destination) window.location.replace(destination);
  }, [destination]);

  if (startupFailure) {
    return (
      <main className="mx-auto grid min-h-screen max-w-lg place-items-center p-6">
        <ResourceFailurePage
          eyebrow="Administration"
          resource="Console"
          returnHref="/workspace/"
          returnLabel="Open Agent workspace"
          failure={startupFailure}
          pending={startupPending}
          onRetry={() => {
            if (startupPending) return;
            setStartupPending(true);
            setStartupAttempt((attempt) => attempt + 1);
          }}
        />
      </main>
    );
  }
  if (session === undefined) return <main className="grid min-h-screen place-items-center"><Loading label="Connecting to Antnest" /></main>;
  if (session === null) return <LoginPage onLogin={startSession} />;
  if (destination) return <main className="grid min-h-screen place-items-center"><Loading label="Opening Agent workspace" /></main>;

  async function logout() {
    if (logoutRequest.current) return;
    const request = Symbol();
    logoutRequest.current = request;
    setLogoutPending(true);
    setLogoutError("");
    try {
      await api.logout();
      if (logoutRequest.current === request) endSession();
    } catch (cause) {
      if (logoutRequest.current === request) {
        setLogoutError(`Sign out could not be confirmed. ${errorMessage(cause)}`);
      }
    } finally {
      if (logoutRequest.current === request) {
        logoutRequest.current = undefined;
        setLogoutPending(false);
      }
    }
  }

  const role = session.principal.system_role === "admin" ? "System administrator" : "Organization administrator";
  const account = accountPresentation(accountState);
  const pageLabel = route.resourceID
    ? route.page === "agents" ? "Agent detail" : route.page === "models" ? "Model detail" : "Template detail"
    : pageLabels[route.page];

  return (
    <div className="min-h-screen bg-background text-foreground lg:grid lg:grid-cols-[248px_1fr]">
      <aside
        id="primary-navigation"
        inert={compactNavigation && !menuOpen}
        className={cn(
          "invisible fixed inset-y-0 left-0 z-40 flex w-[248px] -translate-x-full flex-col border-r border-border bg-[#efefec] shadow-xl transition-[transform,visibility] duration-200 lg:visible lg:translate-x-0 lg:shadow-none",
          menuOpen && "visible translate-x-0",
        )}
        style={{ transitionDelay: menuOpen ? "0s" : "0s, 200ms" }}
      >
        <div className="flex h-[68px] items-center border-b border-border px-5">
          <Brand />
          <Button
            aria-label="Close navigation"
            className="ml-auto lg:hidden"
            id="close-primary-navigation"
            size="icon"
            variant="ghost"
            onClick={closeMenuToTrigger}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <Navigation route={route} onNavigate={closeMenuToContent} />
        <div className="border-t border-border p-3">
          <div aria-live="polite" className="rounded-md bg-muted/70 p-3">
            <div className="flex items-start gap-3">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-[#1d1d1b] text-[#dbff54] shadow-sm">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{account.primary}</span>
                <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                  {account.secondary}
                </span>
              </span>
            </div>
            <div className="mt-2 pl-11 text-[11px] text-muted-foreground">{role}</div>
            <div className="mt-1 flex min-h-8 items-center justify-end gap-0.5 pl-11">
              {account.retryable ? (
                <Button
                  aria-label="Retry account profile"
                  className="h-8 w-8"
                  size="icon"
                  title={accountState.status === "error" ? accountState.failure.message : "Retry account profile"}
                  variant="ghost"
                  onClick={() => setAccountReload((value) => value + 1)}
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
              ) : null}
              {account.localPasswordAvailable ? (
                <Button
                  aria-label="Change local password"
                  className="h-8 w-8"
                  size="icon"
                  title="Change local password"
                  variant="ghost"
                  onClick={() => setAccountSecurityOpen(true)}
                >
                  <KeyRound className="h-4 w-4" />
                </Button>
              ) : null}
              <Button
                aria-busy={logoutPending}
                aria-label="Sign out"
                className="h-8 w-8"
                disabled={logoutPending}
                size="icon"
                title="Sign out"
                variant="ghost"
                onClick={() => void logout()}
              >
                {logoutPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
              </Button>
            </div>
          </div>
          {logoutError ? <div className="mt-2"><ErrorNotice message={logoutError} /></div> : null}
        </div>
      </aside>

      <AccountSecurity
        open={account.localPasswordAvailable && accountSecurityOpen}
        onOpenChange={setAccountSecurityOpen}
      />

      {menuOpen ? (
        <button
          id="primary-navigation-backdrop"
          className="fixed inset-0 z-30 bg-slate-950/35 lg:hidden"
          aria-label="Dismiss navigation"
          tabIndex={-1}
          onClick={closeMenuToTrigger}
          onMouseDown={(event) => event.preventDefault()}
        />
      ) : null}

      <div
        className="min-w-0 lg:col-start-2"
        id="console-content-shell"
        inert={compactNavigation && menuOpen}
      >
        <header className="sticky top-0 z-20 flex h-[68px] items-center border-b border-border bg-[#fbfbfa]/95 px-4 backdrop-blur sm:px-6 lg:px-8">
          <Button
            aria-controls="primary-navigation"
            aria-expanded={menuOpen}
            aria-label="Open navigation"
            className="mr-2 lg:hidden"
            id="open-primary-navigation"
            size="icon"
            variant="ghost"
            onClick={() => setMenuOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </Button>
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="hidden text-muted-foreground sm:inline">Administration</span>
            <ChevronRight className="hidden h-4 w-4 text-slate-300 sm:block" aria-hidden="true" />
            <span className="hidden truncate font-medium sm:inline">{pageLabel}</span>
            <span className="min-w-0 sm:hidden">
              <span className="block truncate font-medium">{pageLabel}</span>
              <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                {account.organizationName}
              </span>
            </span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="max-w-56 truncate text-xs font-medium" title={account.organizationName}>
                {account.organizationName}
              </p>
              <p className="mt-0.5 max-w-56 truncate text-[11px] text-muted-foreground">
                {account.organizationSlug}
              </p>
            </div>
            <span className="flex h-8 items-center gap-2 rounded-md border border-[#cfd8ad] bg-[#f3f9d9] px-3 text-xs font-medium text-[#536700]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#759900]" aria-hidden="true" />
              Session active
            </span>
          </div>
        </header>
        <main
          aria-label={`${pageLabel} page`}
          className="mx-auto w-full max-w-[1500px] px-4 py-6 outline-none sm:px-6 lg:px-8 lg:py-8"
          ref={mainContentRef}
          tabIndex={-1}
        >
          {route.page === "overview" ? <DashboardPage /> : null}
          {route.page === "directory" ? (
            <DirectoryPage
              currentUserID={session.principal.user_id}
              organizationName={account.organizationName}
              systemAdministrator={session.principal.system_role === "admin"}
            />
          ) : null}
          {route.page === "provisioning" ? (
            <ProvisioningPage systemAdministrator={session.principal.system_role === "admin"} />
          ) : null}
          {route.page === "models" ? <ModelsPage modelID={route.resourceID} revisionID={route.revisionID} /> : null}
          {route.page === "templates" ? <TemplatesPage templateID={route.resourceID} revisionID={route.revisionID} /> : null}
          {route.page === "agents" ? <AgentsPage agentID={route.resourceID} networkScope={JSON.stringify([session.principal.organization_id, session.principal.user_id])} /> : null}
        </main>
      </div>
    </div>
  );
}
