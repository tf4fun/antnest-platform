import { LoaderCircle, LogIn } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, errorMessage } from "../lib/api";
import type { Session } from "../lib/types";
import { Button } from "../components/ui/button";
import { ErrorNotice } from "../components/ui/feedback";
import { Field, Input } from "../components/ui/input";

export function LoginPage({ onLogin }: { onLogin: (session: Session) => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    try {
      const session = await api.login(
        String(data.get("organization_slug") ?? ""),
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

  return (
    <main className="grid min-h-screen bg-background lg:grid-cols-[minmax(360px,520px)_1fr]">
      <section className="flex items-center justify-center border-r border-border px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-10 flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-md bg-primary text-sm font-bold text-primary-foreground">A</div>
            <div>
              <p className="font-semibold">Antnest</p>
              <p className="text-xs text-muted-foreground">Administrator Console</p>
            </div>
          </div>
          <h1 className="text-2xl font-semibold tracking-normal">Sign in</h1>
          <p className="mt-2 text-sm text-muted-foreground">Use an administrator account from your organization directory.</p>
          <form className="mt-7 grid gap-4" onSubmit={submit}>
            <Field label="Organization">
              <Input name="organization_slug" autoComplete="organization" defaultValue="engineering" required />
            </Field>
            <Field label="Email">
              <Input name="email" type="email" autoComplete="username" required />
            </Field>
            <Field label="Password">
              <Input name="password" type="password" autoComplete="current-password" required />
            </Field>
            {error ? <ErrorNotice message={error} /> : null}
            <Button className="mt-2 w-full" disabled={pending} type="submit">
              {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
              {pending ? "Signing in" : "Sign in"}
            </Button>
          </form>
        </div>
      </section>
      <aside className="hidden items-end bg-[#132a23] p-12 text-white lg:flex">
        <div className="max-w-lg">
          <p className="text-sm font-medium text-emerald-300">Enterprise Agent Infrastructure</p>
          <p className="mt-3 text-3xl font-semibold leading-tight">Operate every Agent from one accountable control plane.</p>
          <p className="mt-4 text-sm leading-6 text-emerald-50/70">Identity, models, templates, runtimes, and lifecycle evidence stay connected without exposing internal services.</p>
        </div>
      </aside>
    </main>
  );
}
