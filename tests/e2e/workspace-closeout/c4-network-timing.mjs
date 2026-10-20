import assert from "node:assert/strict";

const finite = (value) =>
  assert(
    Number.isFinite(value) && value >= 0,
    "original C4 network time required",
  );
const identifier = (value) =>
  assert(
    typeof value === "string" && value.length > 0,
    "original C4 network identity required",
  );

function sampleBounds(sample) {
  assert(sample, "original C4 clock sample required");
  for (const value of [
    sample.started_at,
    sample.completed_at,
    sample.timestamp,
  ])
    finite(value);
  assert(sample.started_at <= sample.completed_at, "inverted C4 clock sample");
  // Chromium Performance.Timestamp and Network timestamps use TimeTicks.
  // The RPC brackets the original browser sample on the host clock. Keep its
  // full uncertainty; neither callback delivery nor a midpoint is dispatch.
  return {
    lower: sample.timestamp * 1000 - sample.completed_at,
    upper: sample.timestamp * 1000 - sample.started_at,
  };
}

export function inspectC4NetworkTiming({ checkpoint, closure, networkEnd }) {
  const stream = checkpoint?.stream,
    network = stream?.network;
  assert.equal(
    network?.source,
    "chromium-cdp",
    "original C4 native timing required",
  );
  const { request, response, calibration } = network;
  identifier(network.main_frame_id);
  assert(
    request && response && calibration,
    "complete C4 network records required",
  );
  for (const value of [request.request_id, request.frame_id, request.loader_id])
    identifier(value);
  assert.equal(request.frame_id, network.main_frame_id);
  assert.equal(request.type, "EventSource");
  assert.equal(request.method, "GET");
  assert.equal(request.url, stream.origin + stream.path);
  for (const key of ["request_id", "frame_id", "loader_id", "type", "url"])
    assert.equal(
      response[key],
      request[key],
      "C4 native response identity changed",
    );
  assert.equal(response.status, stream.status);
  assert.equal(response.trace_id, stream.trace_id);
  for (const value of [
    request.timestamp,
    request.wall_time,
    response.timestamp,
    stream.started_at,
    stream.headers_at,
    checkpoint.at,
  ])
    finite(value);
  assert(
    request.timestamp <= response.timestamp,
    "C4 response precedes dispatch",
  );
  const samples = [calibration.before, calibration.admission];
  const intervals = samples.map(sampleBounds);
  assert(
    calibration.before.completed_at <= stream.started_at &&
      calibration.before.timestamp <= request.timestamp &&
      response.timestamp <= calibration.admission.timestamp &&
      stream.headers_at <= calibration.admission.started_at &&
      calibration.admission.completed_at <= checkpoint.at,
    "C4 dispatch is not bracketed by its original calibration",
  );
  if (closure) {
    assert(networkEnd?.event, "original C4 native EOF required");
    const event = networkEnd.event;
    assert.equal(event.request_id, request.request_id);
    finite(event.timestamp);
    finite(closure.at);
    if (closure.kind === "remote-end")
      assert.equal(event.kind, "loadingFinished");
    else {
      assert.equal(closure.kind, "transport-end");
      assert.equal(event.kind, "loadingFailed");
      assert.equal(event.error_text, "net::ERR_INCOMPLETE_CHUNKED_ENCODING");
      assert.equal(event.canceled, false);
    }
    intervals.push(sampleBounds(networkEnd.calibration));
    assert(
      event.timestamp >= response.timestamp &&
        event.timestamp >= calibration.admission.timestamp &&
        event.timestamp <= networkEnd.calibration.timestamp &&
        networkEnd.calibration.timestamp >= calibration.admission.timestamp &&
        networkEnd.calibration.started_at >= closure.at &&
        networkEnd.calibration.started_at >= calibration.admission.completed_at,
      "C4 native EOF is not bracketed by its original calibration",
    );
  }
  // The envelope includes every sample and any observed offset drift. A
  // narrower intersection would silently assume a constant offset throughout.
  const offset = {
    lower: Math.min(...intervals.map((value) => value.lower)),
    upper: Math.max(...intervals.map((value) => value.upper)),
  };
  const project = (timestamp) => ({
    lower: timestamp * 1000 - offset.upper,
    upper: timestamp * 1000 - offset.lower,
  });
  const dispatch = project(request.timestamp);
  assert(
    dispatch.lower <= stream.started_at && dispatch.lower <= stream.headers_at,
    "C4 native dispatch follows its original observation",
  );
  const responseBounds = project(response.timestamp);
  assert(
    responseBounds.lower <= stream.headers_at,
    "C4 native response follows its callback",
  );
  const end = closure ? project(networkEnd.event.timestamp) : undefined;
  if (end) {
    assert(end.lower <= closure.at, "C4 native EOF follows its callback");
    // Reject an EOF interval wholly before the trigger. Overlapping clock
    // uncertainty is retained, and the owning cause proof additionally binds
    // the original feed event to the native request-to-EOF elapsed time.
    assert(end.upper >= checkpoint.at, "C4 native EOF precedes its trigger");
  }
  return { dispatch, response: responseBounds, end, offset };
}
