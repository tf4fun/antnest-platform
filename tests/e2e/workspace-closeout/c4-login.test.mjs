import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";
import { member } from "./c4-setup.mjs";

const moduleURL = new URL("./c4-login.mjs", import.meta.url);
const { captureC4Login } = await import(moduleURL).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(moduleURL.pathname)
  )
    throw error;
  return {};
});

function fixture(prefix = "") {
  const frame = {};
  const body = {
    principal: {
      user_id: "original-owner",
      organization_id: "org-1",
      membership_id: "member-1",
      organization_slug: "stage3",
      organization_name: "Stage 3",
      system_role: "user",
      organization_role: "member",
      active: true,
    },
    expires_at: "2026-10-19T10:00:00Z",
    idle_expires_at: "2026-10-19T09:00:00Z",
    activity_interval_ms: 30000,
  };
  const cookies = [
    { name: prefix + "antnest_session", value: "ORIGINAL-C4-LOGIN-TOKEN" },
    { name: prefix + "antnest_csrf", value: "ORIGINAL-C4-LOGIN-CSRF" },
  ];
  const headers = [
    { name: "x-antnest-trace-id", value: "a".repeat(32) },
    { name: "date", value: "Mon, 19 Oct 2026 08:00:00 GMT" },
    ...cookies.map((cookie) => ({
      name: "set-cookie",
      value: `${cookie.name}=${cookie.value}; Path=/; Secure`,
    })),
  ];
  const request = {
    method: () => "POST",
    frame: () => frame,
    postDataJSON: () => member,
  };
  const context = { storageState: async () => ({ cookies }) };
  const page = { mainFrame: () => frame, context: () => context };
  const response = {
    url: () => "http://127.0.0.1:8123/api/session/login",
    request: () => request,
    status: () => 200,
    headersArray: async () => headers,
    text: async () => JSON.stringify(body),
  };
  const startedMono = performance.now(),
    startedAt = Date.now();
  const read = () =>
    captureC4Login(page, response, {
      gateway: "http://127.0.0.1:8123",
      ownerId: "original-owner",
      startedMono,
      startedAt,
    });
  return {
    body,
    cookies,
    headers,
    request,
    context,
    page,
    response,
    read,
    startedMono,
    startedAt,
  };
}

test("C4 login receipt retains the original trigger and completed response window", async () => {
  const f = fixture(),
    result = await f.read();
  assert.equal(result.receipt.startedMono, f.startedMono);
  assert.equal(result.receipt.startedAt, f.startedAt);
  assert(result.receipt.completedMono >= f.startedMono);
  assert(result.receipt.completedAt >= f.startedAt);
});

for (const prefix of ["", "__Host-"])
  test(`C4 freezes its page login Principal and exact issued ${prefix}Cookie pair`, async () => {
    assert.equal(typeof captureC4Login, "function");
    const f = fixture(prefix),
      result = await f.read();
    assert.deepEqual(result.issued, f.body);
    assert.deepEqual(result.cookies, f.cookies);
    assert.equal(result.receipt.traceID, "a".repeat(32));
    assert.equal(result.receipt.rawBody, JSON.stringify(f.body));
    assert(!JSON.stringify(result.receipt).includes(f.cookies[0].value));
    f.cookies[0].value = "replacement";
    f.body.principal.user_id = "replacement";
    assert.equal(result.cookies[0].value, "ORIGINAL-C4-LOGIN-TOKEN");
    assert.equal(result.issued.principal.user_id, "original-owner");
  });

for (const [name, change] of [
  [
    "foreign page",
    (f) => {
      f.request.frame = () => ({ password: member.password });
    },
  ],
  [
    "foreign origin",
    (f) => {
      f.response.url = () => "https://other.invalid/api/session/login";
    },
  ],
  [
    "another endpoint",
    (f) => {
      f.response.url = () => "http://127.0.0.1:8123/api/session";
    },
  ],
  [
    "another login body",
    (f) => {
      f.request.postDataJSON = () => ({
        ...member,
        email: "someone-else@example.com",
      });
    },
  ],
  [
    "missing Principal fields",
    (f) => {
      delete f.body.principal.membership_id;
    },
  ],
  [
    "another owner",
    (f) => {
      f.body.principal.user_id = "other-owner";
    },
  ],
  [
    "inactive member",
    (f) => {
      f.body.principal.active = false;
    },
  ],
  [
    "expired authority",
    (f) => {
      f.body.idle_expires_at = "2026-10-19T07:00:00Z";
    },
  ],
  [
    "idle expiry after absolute expiry",
    (f) => {
      f.body.idle_expires_at = "2026-10-19T11:00:00Z";
    },
  ],
  [
    "different browser session",
    (f) => {
      f.cookies[0].value = "REPLACED-C4-TOKEN";
    },
  ],
  [
    "different browser CSRF",
    (f) => {
      f.cookies[1].value = "REPLACED-C4-CSRF";
    },
  ],
  [
    "missing actual Trace",
    (f) => {
      f.headers[0].value = "";
    },
  ],
  [
    "reflected token in owner",
    (f) => {
      f.body.principal.user_id = "ORIGINAL-C4-LOGIN-TOKEN";
    },
  ],
  [
    "reflected password in Organization",
    (f) => {
      f.body.principal.organization_name = member.password;
    },
  ],
  [
    "reflected token in Trace header",
    (f) => {
      f.headers[0].value = "ORIGINAL-C4-LOGIN-TOKEN";
    },
  ],
  [
    "malformed request JSON containing a password",
    (f) => {
      f.request.postDataJSON = () => JSON.parse(member.password);
    },
  ],
  [
    "malformed response JSON containing a token",
    (f) => {
      f.response.text = async () => "ORIGINAL-C4-LOGIN-TOKEN";
    },
  ],
])
  test(`C4 refuses ${name} as its original UI login`, async () => {
    assert.equal(typeof captureC4Login, "function");
    const f = fixture();
    change(f);
    await assert.rejects(f.read(), (error) => {
      for (const value of [
        member.password,
        "ORIGINAL-C4-LOGIN-TOKEN",
        "ORIGINAL-C4-LOGIN-CSRF",
        "REPLACED-C4-TOKEN",
        "REPLACED-C4-CSRF",
      ])
        assert(
          !inspect(error).includes(value),
          "original login secret appeared in a diagnostic",
        );
      return true;
    });
  });

test("C4 preserves the original login body read failure", async () => {
  const f = fixture(),
    failure = new Error("original response body failure");
  f.response.text = async () => {
    throw failure;
  };
  await assert.rejects(f.read(), (error) => error === failure);
});
