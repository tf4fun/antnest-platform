import WebSocket from "ws";

const acpUrl = required("ANTNEST_STAGE2_ACP_URL");
const accessSubject = required("ANTNEST_STAGE2_AGENT_ACCESS_SUBJECT");
const expectedStatus = Number.parseInt(required("ANTNEST_STAGE2_EXPECTED_UPGRADE_STATUS"), 10);
if (!Number.isInteger(expectedStatus) || expectedStatus < 400 || expectedStatus > 599) {
  throw new Error("ANTNEST_STAGE2_EXPECTED_UPGRADE_STATUS must be an HTTP error status");
}

const actualStatus = await new Promise((resolve, reject) => {
  const socket = new WebSocket(acpUrl, {
    headers: { "x-antnest-agent-access-subject": accessSubject },
  });
  const timeout = setTimeout(() => {
    socket.terminate();
    reject(new Error("ACP upgrade did not complete"));
  }, 10_000);
  timeout.unref();
  socket.once("unexpected-response", (_request, response) => {
    clearTimeout(timeout);
    response.resume();
    resolve(response.statusCode ?? 0);
  });
  socket.once("open", () => {
    clearTimeout(timeout);
    socket.terminate();
    resolve(101);
  });
  socket.once("error", (error) => {
    clearTimeout(timeout);
    reject(error);
  });
});

if (actualStatus !== expectedStatus) {
  throw new Error(`ACP upgrade status ${actualStatus}, want ${expectedStatus}`);
}
process.stdout.write(`${JSON.stringify({ upgrade_status: actualStatus })}\n`);

function required(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}
