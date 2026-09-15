import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import type { tracing } from "@opentelemetry/sdk-node";
import { boundaryConfig, recordBoundaryError } from "./diagnostics.js";

export function createPostgresInstrumentation(): PgInstrumentation {
  return new PgInstrumentation({
    ignoreConnectSpans: true,
    enhancedDatabaseReporting: false,
    requireParentSpan: true,
    responseHook(span, { data }) {
      if (Array.isArray(data)) {
        span.updateName("BATCH");
        span.setAttribute("db.operation.name", "BATCH");
        return;
      }
      span.updateName(data.command);
      span.setAttribute("db.operation.name", data.command);
    },
  });
}

// The pinned SDK puts the operation in its title but only emits it on metrics.
// Normalize that presentation, not SQL. Successful queries use pg's command above.
export class PostgresSpanNames implements tracing.SpanProcessor {
  public onStart(span: tracing.Span): void {
    if (span.instrumentationScope.name !== "@opentelemetry/instrumentation-pg") return;
    const prefix = "pg.query:";
    if (!span.name.startsWith(prefix)) return;
    const namespace = span.attributes["db.namespace"];
    const suffix = typeof namespace === "string" && namespace ? ` ${namespace}` : "";
    const label = span.name.slice(prefix.length, suffix ? -suffix.length : undefined).trim();
    const operation = /^[A-Z]+$/u.test(label) ? label : "QUERY";
    span.updateName(operation);
    span.setAttribute("db.operation.name", operation);
  }
  public onEnd(): void {}
  public onEnding(span: tracing.Span): void {
    if (span.instrumentationScope.name !== "@opentelemetry/instrumentation-pg") return;
    if (span.status.code !== SpanStatusCode.ERROR) return;
    const exception = span.events.find((event) => event.name === "exception");
    span.setAttribute("error.type", exception?.attributes?.["exception.type"] ?? "database_error");
  }
  public forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  public shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

type TransactionOutcome = "committed" | "rolled_back" | "failed";

export function observePostgresTransaction<T>(
  operation: (finish: (outcome: TransactionOutcome) => void) => Promise<T>,
): Promise<T> {
  if (boundaryConfig().disabled || !trace.getSpan(context.active())?.isRecording()) {
    return operation(() => undefined);
  }
  return trace
    .getTracer("agent-acp-service.database")
    .startActiveSpan(
      "postgresql transaction",
      { attributes: { "db.system.name": "postgresql" } },
      async (span) => {
        let outcome: TransactionOutcome = "failed";
        try {
          return await operation((result) => {
            outcome = result;
          });
        } catch (error) {
          recordBoundaryError(span, error, "postgresql transaction");
          throw error;
        } finally {
          span.setAttribute("antnest.transaction.outcome", outcome);
          span.end();
        }
      },
    );
}
