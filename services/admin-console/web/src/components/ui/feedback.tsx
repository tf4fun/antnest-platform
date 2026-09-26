import { AlertCircle, CircleAlert, CircleCheck, Inbox, LoaderCircle, X } from "lucide-react";
import type { ReactNode } from "react";

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div
      aria-atomic="true"
      aria-live="polite"
      className="flex min-h-56 flex-col items-center justify-center gap-3 text-sm text-muted-foreground"
      role="status"
    >
      <span className="grid h-10 w-10 place-items-center rounded-full border border-border bg-white shadow-xs">
        <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin text-primary" />
      </span>
      {label}
    </div>
  );
}

export function ErrorNotice({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 shadow-xs sm:flex-row sm:items-center">
      <div aria-atomic="true" className="flex min-w-0 flex-1 items-start gap-2" role="alert">
        <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{message}</span>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function GuidanceNotice({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-amber-200 bg-amber-50/70 p-3.5 text-sm text-amber-950 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <CircleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
        <span>{message}</span>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function SuccessNotice({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 shadow-xs">
      <div aria-atomic="true" className="flex min-w-0 flex-1 items-start gap-2" role="status">
        <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">{message}</span>
      </div>
      {onDismiss ? (
        <button
          aria-label="Dismiss success message"
          className="-m-1 grid h-7 w-7 shrink-0 place-items-center rounded-sm text-emerald-800 transition-colors hover:bg-emerald-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-emerald-700/30"
          title="Dismiss"
          type="button"
          onClick={onDismiss}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export function Empty({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center rounded-md border border-dashed border-border bg-white px-5 text-center">
      <span className="mb-3 grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground">
        <Inbox className="h-4 w-4" aria-hidden="true" />
      </span>
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{detail}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
