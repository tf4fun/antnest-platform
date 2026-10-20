// Source-shaped CDP records for validator tests; no browser action is emulated.
export function addC4NetworkTiming(expected) {
  const point = expected.checkpoint,
    stream = point.stream;
  const offset = 100000;
  const sample = (at) => ({
    started_at: at - 1,
    completed_at: at + 1,
    timestamp: (offset + at) / 1000,
  });
  stream.network = {
    source: "chromium-cdp",
    main_frame_id: "main-frame",
    request: {
      request_id: "native-request-1",
      frame_id: "main-frame",
      loader_id: "original-document",
      type: "EventSource",
      method: "GET",
      url: stream.origin + stream.path,
      timestamp: (offset + 1000) / 1000,
      wall_time: stream.started_at_ms / 1000,
    },
    response: {
      request_id: "native-request-1",
      frame_id: "main-frame",
      loader_id: "original-document",
      type: "EventSource",
      url: stream.origin + stream.path,
      timestamp: (offset + 1150) / 1000,
      status: 200,
      trace_id: stream.trace_id,
    },
    calibration: { before: sample(950), admission: sample(1250) },
  };
  expected.networkEnd = {
    event: {
      request_id: "native-request-1",
      kind:
        expected.closure.kind === "remote-end"
          ? "loadingFinished"
          : "loadingFailed",
      timestamp: (offset + expected.closure.at - 5) / 1000,
      ...(expected.closure.kind === "remote-end"
        ? {}
        : {
            error_text: "net::ERR_INCOMPLETE_CHUNKED_ENCODING",
            canceled: false,
          }),
    },
    calibration: sample(expected.closure.at + 10),
  };
  return expected;
}
