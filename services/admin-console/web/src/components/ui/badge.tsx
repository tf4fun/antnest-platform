import { cn } from "../../lib/utils";

const positive = new Set(["ready", "available", "enabled", "active", "completed", "succeeded"]);
const negative = new Set(["failed", "deleted", "disabled", "inactive", "error"]);

export function Badge({ value, className }: { value: string; className?: string }) {
  const normalized = value.toLowerCase();
  return (
    <span
      className={cn(
        "inline-flex min-h-6 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium capitalize",
        positive.has(normalized) && "border-emerald-200 bg-emerald-50 text-emerald-700",
        negative.has(normalized) && "border-red-200 bg-red-50 text-red-700",
        !positive.has(normalized) && !negative.has(normalized) && "border-amber-200 bg-amber-50 text-amber-800",
        className,
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-hidden="true" />
      {value.replaceAll("_", " ")}
    </span>
  );
}
