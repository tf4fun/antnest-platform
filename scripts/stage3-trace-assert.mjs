const endpoint = new URL(`/api/traces/${required(3)}`, required(2));
const traceId = required(3);
const expectedServices = process.argv.slice(4);
if (expectedServices.length === 0) {
  throw new Error("at least one expected service is required");
}

let lastServices = [];
let lastQueryError = "";
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    const response = await fetch(endpoint);
    if (!response.ok) throw new Error(`Jaeger query returned ${response.status}`);
    const payload = await response.json();
    const trace = payload?.data?.[0];
    if (trace?.spans?.length > 0) {
      const encoded = JSON.stringify(trace);
      for (const forbidden of ["stage3-admin-password", "stage3-provider-secret"]) {
        if (encoded.includes(forbidden)) throw new Error("trace contains secret material");
      }
      const services = new Set(
        trace.spans
          .map((span) => trace.processes?.[span.processID]?.serviceName)
          .filter(Boolean),
      );
      lastServices = [...services].sort();
      lastQueryError = "";
      if (expectedServices.every((service) => services.has(service))) {
        process.stdout.write(
          `${JSON.stringify({ trace_id: traceId, services: lastServices, spans: trace.spans.length })}\n`,
        );
        process.exit(0);
      }
    }
  } catch (error) {
    if (String(error).includes("secret material")) throw error;
    lastQueryError = String(error);
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
throw new Error(
  `trace ${traceId} lacks the Stage 3 topology; observed services: ${lastServices.join(", ")}; ` +
  `query_error: ${lastQueryError || "none"}`,
);

function required(index) {
  const value = process.argv[index];
  if (!value) throw new Error(`argument ${index - 1} is required`);
  return value;
}
