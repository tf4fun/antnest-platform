import assert from "node:assert/strict";
import test from "node:test";
import { accountPresentation } from "./account.ts";

test("current account displays human identity and authoritative password capability", () => {
  assert.deepEqual(
    accountPresentation({
      status: "ready",
      data: {
        email: "alice@example.com",
        display_name: "Alice",
        source: "local",
        organization_slug: "engineering",
        organization_name: "Engineering",
        local_password_available: true,
      },
    }),
    {
      primary: "Alice",
      secondary: "alice@example.com",
      organizationName: "Engineering",
      organizationSlug: "engineering",
      localPasswordAvailable: true,
      retryable: false,
    },
  );
});

test("account capability fails closed while loading or unavailable", () => {
  assert.deepEqual(accountPresentation({ status: "loading" }), {
    primary: "Signed-in account",
    secondary: "Loading account profile",
    organizationName: "Organization",
    organizationSlug: "Loading profile",
    localPasswordAvailable: false,
    retryable: false,
  });
  assert.deepEqual(
    accountPresentation({
      status: "error",
      failure: {
        kind: "unavailable",
        message: "identity unavailable",
        retryable: true,
      },
    }),
    {
      primary: "Signed-in account",
      secondary: "Account profile unavailable",
      organizationName: "Organization",
      organizationSlug: "Profile unavailable",
      localPasswordAvailable: false,
      retryable: true,
    },
  );
});

test("account presentation does not retry a terminal permission failure", () => {
  assert.equal(accountPresentation({
    status: "error",
    failure: {
      kind: "forbidden",
      message: "Administrator access is required.",
      retryable: false,
    },
  }).retryable, false);
});

test("external-only account does not expose local password rotation", () => {
  const presentation = accountPresentation({
    status: "ready",
    data: {
      email: "external@example.com",
      display_name: "External User",
      source: "scim",
      organization_slug: "engineering",
      organization_name: "Engineering",
      local_password_available: false,
    },
  });
  assert.equal(presentation.localPasswordAvailable, false);
});
