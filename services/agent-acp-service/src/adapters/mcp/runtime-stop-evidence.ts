const builtins = new Set(["bash", "read", "write", "edit"]);
const completedBuiltinErrors = new Set([
  "invalid_params",
  "invalid_path",
  "runtime_busy",
  "runtime_unavailable",
  "spawn_failed",
  "canceled",
  "timeout",
  "wait_failed",
  "output_capture_failed",
  "encode_result_failed",
  "read_failed",
  "content_not_utf8",
  "write_failed",
  "edit_read_failed",
  "old_string_not_found",
  "old_string_not_unique",
  "result_too_large",
  "edit_failed",
]);

export function runtimeCallStopped(
  name: string,
  result: { isError: boolean; structuredContent?: unknown },
): boolean {
  const value = result.structuredContent;
  const fields =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  if (value !== undefined && fields === undefined) return false;
  const code = fields?.error_code;
  if (code === "child_process_containment_unproven" || code === "runtime_failed") return false;
  if (name.startsWith("mcp__")) {
    // A normal child reply completes that invocation. A cancellation/unknown
    // envelope cannot distinguish a still-running child from a lost response.
    return code !== "outcome_unknown" && fields?.effect_state !== "unknown";
  }
  if (!builtins.has(name) || fields === undefined) return false;
  if (code === "outcome_unknown") {
    // File operations return after their executor ends. An exited Bash parent
    // alone does not prove that its foreground shell has stopped.
    return (
      result.isError &&
      (name === "write" || name === "edit") &&
      fields.effect_state === "unknown" &&
      fields.effect_source === "runtime_mcp"
    );
  }
  if (fields.effect_source !== null) return false;
  if (!result.isError) return fields.effect_state === "settled" && code === undefined;
  return (
    typeof code === "string" &&
    completedBuiltinErrors.has(code) &&
    (fields.effect_state === "none" || fields.effect_state === "settled")
  );
}
