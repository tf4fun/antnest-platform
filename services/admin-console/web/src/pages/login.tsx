import { Building2, KeyRound, LoaderCircle, LogIn, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Brand } from "../components/brand";
import { api, errorMessage } from "../lib/api";
import { authorizationDestination, callbackError } from "../lib/login";
import type { LoginMethod, Session } from "../lib/types";
import { Button } from "../components/ui/button";
import { ErrorNotice } from "../components/ui/feedback";
import { Field, Input } from "../components/ui/input";

export function LoginPage({ onLogin }: { onLogin: (session: Session) => void }) {
  const [pending, setPending] = useState(false);
  const [organization, setOrganization] = useState("engineering");
  const [error, setError] = useState(() => callbackError(window.location.search));
  const [methods, setMethods] = useState<LoginMethod[]>([]);
  const [methodsPending, setMethodsPending] = useState(false);
  const [methodsError, setMethodsError] = useState("");
  const [methodRefresh, setMethodRefresh] = useState(0);
  const [startingMethod, setStartingMethod] = useState("");

  useEffect(() => {
    const location = new URL(window.location.href);
    if (!location.searchParams.has("auth_error")) return;
    location.searchParams.delete("auth_error");
    window.history.replaceState(null, "", `${location.pathname}${location.search}${location.hash}`);
  }, []);

  useEffect(() => {
    const slug = organization.trim();
    setMethods([]);
    setMethodsError("");
    setMethodsPending(Boolean(slug));
    if (!slug) {
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      api.loginMethods(slug)
        .then((result) => {
          if (active) setMethods(result.methods);
        })
        .catch(() => {
          if (active) {
            setMethods([]);
            setMethodsError("Single sign-on options could not be loaded.");
          }
        })
        .finally(() => {
          if (active) setMethodsPending(false);
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [organization, methodRefresh]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    try {
      const session = await api.login(
        organization,
        String(data.get("email") ?? ""),
        String(data.get("password") ?? ""),
      );
      onLogin(session);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function startOIDC(method: LoginMethod) {
    setStartingMethod(method.name);
    setError("");
    try {
      const result = await api.startOIDCLogin(organization.trim(), method.name);
      window.location.assign(authorizationDestination(result.authorization_url));
    } catch (cause) {
      setError(errorMessage(cause));
      setStartingMethod("");
    }
  }

  return (
    <main className="grid min-h-screen bg-background lg:grid-cols-[minmax(380px,44%)_1fr]">
      <aside className="relative hidden overflow-hidden bg-[#1d1d1b] px-12 py-10 text-white lg:flex lg:flex-col">
        <Brand inverse />
        <div className="my-auto max-w-lg py-16">
          <p className="text-sm font-medium text-[#dbff54]">Antnest Platform</p>
          <h1 className="mt-5 text-5xl font-semibold leading-[1.08]">Antnest</h1>
          <p className="mt-5 max-w-md text-lg leading-7 text-white/68">A clear operating surface for your organization&apos;s Agent fleet.</p>
        </div>
        <div className="flex items-center gap-3 border-t border-white/12 pt-6 text-xs text-white/58">
          <ShieldCheck className="h-4 w-4 text-[#dbff54]" aria-hidden="true" />
          Organization access is managed by Identity Service
        </div>
        <div className="pointer-events-none absolute right-12 top-0 h-full w-px bg-white/[0.04]" aria-hidden="true" />
        <div className="pointer-events-none absolute right-32 top-0 h-full w-px bg-white/[0.04]" aria-hidden="true" />
      </aside>
      <section className="flex min-h-screen items-center justify-center px-6 py-12 sm:px-10">
        <div className="w-full max-w-[420px]">
          <div className="mb-12 lg:hidden">
            <Brand />
          </div>
          <span className="mb-5 grid h-10 w-10 place-items-center rounded-md border border-border bg-white text-primary shadow-sm">
            <KeyRound className="h-[18px] w-[18px]" aria-hidden="true" />
          </span>
          <h1 className="text-[28px] font-semibold leading-tight">Welcome back</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">Sign in with your organization account.</p>
          <form className="mt-8 grid gap-5" onSubmit={submit}>
            <Field label="Organization">
              <Input
                name="organization_slug"
                autoComplete="organization"
                value={organization}
                onChange={(event) => setOrganization(event.target.value)}
                placeholder="Organization slug"
                required
              />
            </Field>
            {methodsError ? (
              <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>{methodsError}</span>
                <Button
                  aria-label="Retry single sign-on discovery"
                  size="icon"
                  type="button"
                  variant="ghost"
                  onClick={() => setMethodRefresh((value) => value + 1)}
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
            ) : null}
            <Field label="Email">
              <Input name="email" type="email" autoComplete="username" placeholder="admin@example.com" required />
            </Field>
            <Field label="Password">
              <Input name="password" type="password" autoComplete="current-password" placeholder="Enter your password" required />
            </Field>
            {error ? <ErrorNotice message={error} /> : null}
            <Button aria-busy={pending} className="mt-1 h-10 w-full" disabled={pending || Boolean(startingMethod)} type="submit">
              {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
              {pending ? "Signing in" : "Sign in"}
            </Button>
          </form>
          {methods.length > 0 || methodsPending ? (
            <div className="mt-7">
              <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                <span>Organization sign-in</span>
                <span className="h-px flex-1 bg-border" />
              </div>
              <div className="mt-4 grid gap-2">
                {methodsPending && methods.length === 0 ? (
                  <Button aria-busy="true" className="w-full" disabled type="button" variant="secondary">
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                    Loading sign-in options
                  </Button>
                ) : null}
                {methods.map((method) => (
                  <Button
                    aria-busy={startingMethod === method.name}
                    className="w-full"
                    disabled={pending || Boolean(startingMethod)}
                    key={method.name}
                    type="button"
                    variant="secondary"
                    onClick={() => void startOIDC(method)}
                  >
                    {startingMethod === method.name
                      ? <LoaderCircle className="h-4 w-4 animate-spin" />
                      : <Building2 className="h-4 w-4" />}
                    Continue with {method.display_name}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
          <p className="mt-8 text-center text-xs text-muted-foreground">Antnest organization access</p>
        </div>
      </section>
    </main>
  );
}
