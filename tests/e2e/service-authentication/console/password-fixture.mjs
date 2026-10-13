// Identity double responses for the Console-owned consumer admission.
export const passwordCanary = "console-password-private-canary";
const busy = {
  code: "credential_busy",
  message: "Password verification is busy",
  retryable: true,
};
const success = {
  user: { id: "unexpected-user", active: true, system_role: "user" },
  membership: {
    id: "unexpected-member",
    user_id: "unexpected-user",
    email: "unexpected@example.test",
    display_name: "Unexpected",
    role: "member",
    source: "local",
    active: true,
  },
};
const json = JSON.stringify;
export const passwordCases = [
  { id: "busy", status: 503, body: json(busy), retry: ["1"], valid: true },
  { id: "missing-retry", status: 503, body: json(busy) },
  { id: "duplicate-retry", status: 503, body: json(busy), retry: ["1", "1"] },
  { id: "wrong-retry", status: 503, body: json(busy), retry: ["2"] },
  { id: "noncanonical-retry", status: 503, body: json(busy), retry: ["01"] },
  { id: "wrong-status", status: 400, body: json(busy), retry: ["1"] },
  {
    id: "mixed-success",
    status: 200,
    body: json({ ...success, ...busy }),
    retry: ["1"],
  },
  {
    id: "mixed-case-success",
    status: 201,
    body: json({ ...success, CoDe: "credential_busy" }),
    retry: ["1"],
  },
  {
    id: "wrong-message",
    status: 503,
    body: json({ ...busy, message: passwordCanary }),
    retry: ["1"],
  },
  {
    id: "false-retryable",
    status: 503,
    body: json({ ...busy, retryable: false }),
    retry: ["1"],
  },
  {
    id: "missing-retryable",
    status: 503,
    body: json({ code: busy.code, message: busy.message }),
    retry: ["1"],
  },
  {
    id: "extra-field",
    status: 503,
    body: json({ ...busy, password: passwordCanary }),
    retry: ["1"],
  },
  {
    id: "duplicate-code",
    status: 503,
    body: json(busy).slice(0, -1) + ',"code":"credential_busy"}',
    retry: ["1"],
  },
  {
    id: "trailing-document",
    status: 503,
    body: json(busy) + "{}",
    retry: ["1"],
  },
  {
    id: "unexpected-rate",
    status: 429,
    body: json({
      code: "credential_rate_limited",
      message: "Too many password attempts",
      retryable: true,
    }),
    retry: ["1"],
  },
  {
    id: "unknown-code",
    status: 503,
    body: json({ code: passwordCanary, message: passwordCanary }),
    retry: ["1"],
  },
  { id: "transport", disconnect: true },
];
export const passwordCaseEmail = (id) => `${id}@password-admission.test`;
