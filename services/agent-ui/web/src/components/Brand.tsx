import { Workflow } from "lucide-react";
import type { ReactNode } from "react";

export function Brand({ subtitle }: { subtitle?: ReactNode }) {
  return (
    <div className="brand" aria-label="Antnest Workspace">
      <span className="brand-mark">
        <Workflow size={18} strokeWidth={2.2} aria-hidden="true" />
      </span>
      <div className="brand-copy">
        <strong>Antnest</strong>
        {subtitle ?? <small>Workspace</small>}
      </div>
    </div>
  );
}
