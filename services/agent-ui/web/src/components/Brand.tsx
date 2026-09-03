import { Workflow } from "lucide-react";

export function Brand() {
  return (
    <div className="brand" aria-label="Antnest Workspace">
      <span className="brand-mark">
        <Workflow size={18} strokeWidth={2.2} aria-hidden="true" />
      </span>
      <span className="brand-copy">
        <strong>Antnest</strong>
        <small>Workspace</small>
      </span>
    </div>
  );
}
