import { ArrowLeft, ChevronDown, LoaderCircle, RefreshCw, Search } from "lucide-react";
import type { InputHTMLAttributes, ReactNode } from "react";
import type { ResourceFailure } from "../lib/resource-failure";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { ErrorNotice } from "./ui/feedback";
import { Input } from "./ui/input";

export function PageHeader({
  title,
  detail,
  eyebrow,
  actions,
}: {
  title: string;
  detail: string;
  eyebrow?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow ? <p className="mb-1 text-xs font-medium text-primary">{eyebrow}</p> : null}
        <h1 className="text-[23px] font-semibold leading-tight text-foreground">{title}</h1>
        <p className="mt-1.5 max-w-3xl text-sm leading-5 text-muted-foreground">{detail}</p>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function ResourceFailurePage({
  eyebrow,
  resource,
  returnHref,
  returnLabel,
  failure,
  pending,
  onRetry,
}: {
  eyebrow: string;
  resource: string;
  returnHref: string;
  returnLabel: string;
  failure: ResourceFailure;
  pending?: boolean;
  onRetry: () => void;
}) {
  const noun = resource.toLowerCase();
  const title = failure.kind === "not_found"
    ? `${resource} not found`
    : failure.kind === "forbidden"
      ? `${resource} access denied`
      : resource;
  const detail = failure.kind === "not_found"
    ? `This ${noun} may have been removed, or the link is no longer valid.`
    : failure.kind === "forbidden"
      ? `Your account does not have permission to view this ${noun}.`
      : `The ${noun} could not be loaded.`;

  return (
    <div className="grid gap-5">
      <Button asChild className="w-fit" size="sm" variant="ghost">
        <a href={returnHref}><ArrowLeft className="h-4 w-4" />{returnLabel}</a>
      </Button>
      <PageHeader eyebrow={eyebrow} title={title} detail={detail} />
      <ResourceFailureNotice failure={failure} pending={pending} retryLabel="Retry" onRetry={onRetry} />
    </div>
  );
}

export function ResourceFailureNotice({
  failure,
  pending = false,
  message,
  retryLabel,
  onRetry,
}: {
  failure: ResourceFailure;
  pending?: boolean;
  message?: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  return (
    <ErrorNotice
      message={message ?? failure.message}
      action={failure.retryable ? (
        <Button aria-busy={pending} disabled={pending} size="sm" variant="secondary" onClick={onRetry}>
          <RefreshCw className={cn("h-4 w-4", pending && "animate-spin")} />{retryLabel}
        </Button>
      ) : undefined}
    />
  );
}

export function DataTable({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-x-auto rounded-md border border-border bg-white shadow-sm", className)}>
      {children}
    </div>
  );
}

export function MobileResourceList({
  children,
  className,
  label,
}: {
  children: ReactNode;
  className?: string;
  label: string;
}) {
  return (
    <ul aria-label={label} className={cn("grid gap-2 md:hidden", className)}>
      {children}
    </ul>
  );
}

export function MobileResourceItem({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <li className={cn("min-w-0 rounded-md border border-border bg-white p-4 shadow-sm", className)}>
      {children}
    </li>
  );
}

export function Section({
  title,
  detail,
  action,
  children,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {detail ? <p className="mt-1 text-sm text-muted-foreground">{detail}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function SearchField({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={cn("relative block w-full sm:w-72", className)}>
      <span className="sr-only">Search</span>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input className="pl-9" type="search" {...props} />
    </label>
  );
}

export function ResourceToolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">{children}</div>;
}

export function ListPagination({
  loaded,
  hasMore,
  pending,
  failure,
  onLoadMore,
}: {
  loaded: number;
  hasMore: boolean;
  pending: boolean;
  failure?: ResourceFailure;
  onLoadMore: () => void;
}) {
  if (!hasMore && !failure) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
      <p className={cn("text-sm text-muted-foreground", failure && "text-destructive")} role={failure ? "alert" : undefined}>
        {failure?.message ?? `${loaded} loaded. More records are available.`}
      </p>
      {!failure || failure.retryable ? (
        <Button aria-busy={pending} className="w-fit" disabled={pending} size="sm" type="button" variant="secondary" onClick={onLoadMore}>
          {pending
            ? <LoaderCircle className="h-4 w-4 animate-spin" />
            : failure
              ? <RefreshCw className="h-4 w-4" />
              : <ChevronDown className="h-4 w-4" />}
          {failure ? "Retry" : "Load more"}
        </Button>
      ) : null}
    </div>
  );
}
