import type { ReactNode } from "react";

export function PageHeader({ title, detail, actions }: { title: string; detail: string; actions?: ReactNode }) {
  return (
    <header className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal text-foreground">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function DataTable({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto border-y border-border">{children}</div>;
}

export function Section({ title, detail, children }: { title: string; detail?: string; children: ReactNode }) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-base font-semibold">{title}</h2>
        {detail ? <p className="mt-0.5 text-sm text-muted-foreground">{detail}</p> : null}
      </div>
      {children}
    </section>
  );
}
