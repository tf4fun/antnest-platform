// Container fixtures connect over the private service network but represent
// browsers at the deployment's public origin. Host clients keep their own URL.
export function gatewayOrigin(transportURL, environment = process.env) {
  const transport = new URL(transportURL);
  if (transport.hostname !== "edge-gateway") return transport.origin;
  const configured =
    environment.TEST_GATEWAY_PUBLIC_URL ||
    environment.ANTNEST_EDGE_PUBLIC_BASE_URL;
  return configured ? new URL(configured).origin : transport.origin;
}
