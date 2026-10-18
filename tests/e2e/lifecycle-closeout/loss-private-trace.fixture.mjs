import { privatePlanRequestFixture } from "../acp-plan/private-request.fixture.mjs";

export function lossPrivateTraceFixture() {
  const f = privatePlanRequestFixture({
    version: 1,
    method: "session/prompt",
    denial: "agent_unavailable",
  });
  Object.assign(f.expected, {
    kind: "request",
    rejection: "agent_unavailable",
  });
  const eventField = (key, value) => {
    const event = f.application.logs[0];
    event.fields = event.fields.filter((field) => field.key !== key);
    event.fields.push({ key, value });
  };
  for (const key of ["error.code", "antnest.error.code"])
    f.field(f.application, key, "agent_unavailable");
  eventField("antnest.error.code", "agent_unavailable");
  eventField("antnest.error.message", "Operation reported agent_unavailable");
  eventField(
    "antnest.error.causes",
    JSON.stringify([
      {
        type: "DomainError",
        code: "agent_unavailable",
        message: "Operation reported agent_unavailable",
      },
    ]),
  );
  return { ...f, eventField };
}
