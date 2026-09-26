import { X } from "lucide-react";
import type { ControlResult } from "../../server/src/protocol/workspace-commands.ts";

export function CommandResponse({ result, onDismiss }: { result: ControlResult; onDismiss(): void }) {
  return <section className="command-response" aria-label="Command response">
    <div className="command-response-heading">
      <strong>/{result.command}</strong>
      <button type="button" className="icon-button" onClick={onDismiss} aria-label="Dismiss command response">
        <X size={15} aria-hidden="true" />
      </button>
    </div>
    <pre role="status">{result.text}</pre>
  </section>;
}
