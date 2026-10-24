export type PublicationResponse = { status: number; body: unknown };

export async function replayPublicationOnce(
  request: (signal: AbortSignal) => Promise<PublicationResponse>,
  signal: AbortSignal,
): Promise<PublicationResponse> {
  signal.throwIfAborted();
  let response = await request(signal);
  signal.throwIfAborted();
  const body = response.body;
  if (
    response.status === 503 &&
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    "code" in body &&
    body.code === "configuration_unavailable" &&
    "retryable" in body &&
    body.retryable === true
  ) {
    // The caller retains each original receipt and the same serialized snapshot.
    // Never renew the original deadline or overlap the original response cleanup.
    response = await request(signal);
    signal.throwIfAborted();
  }
  return response;
}
