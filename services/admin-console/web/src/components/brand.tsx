import { Workflow } from "lucide-react";
import { cn } from "../lib/utils";

export function Brand({ compact = false, inverse = false }: { compact?: boolean; inverse?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span
        className={cn(
          "grid h-9 w-9 shrink-0 place-items-center rounded-md",
          inverse ? "bg-white text-[#759900]" : "bg-[#1d1d1b] text-[#dbff54]",
        )}
      >
        <Workflow className="h-[18px] w-[18px]" aria-hidden="true" />
      </span>
      {!compact ? (
        <span className="min-w-0 leading-none">
          <span className="block truncate text-[15px] font-semibold">Antnest</span>
          <span className={cn("mt-1 block truncate text-[11px]", inverse ? "text-white/60" : "text-muted-foreground")}>
            Control
          </span>
        </span>
      ) : null}
    </div>
  );
}
