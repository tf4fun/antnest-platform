import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [result, setResult] = useState<{
    text: string;
    outcome: "copied" | "failed";
  }>();
  const outcome = result?.text === text ? result.outcome : undefined;
  const title =
    outcome === "failed"
      ? "Copy failed. Try again"
      : outcome === "copied"
        ? "Copied"
        : label;
  return (
    <>
      <button
        className="icon-button copy-button"
        type="button"
        title={title}
        aria-label={label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setResult({ text, outcome: "copied" });
          } catch {
            setResult({ text, outcome: "failed" });
          }
        }}
      >
        {outcome === "copied" ? (
          <Check size={14} aria-hidden="true" />
        ) : (
          <Copy size={14} aria-hidden="true" />
        )}
      </button>
      <span className="sr-only" role="status">
        {outcome ? title : ""}
      </span>
    </>
  );
}
