import assert from "node:assert/strict";
import test from "node:test";
import {
  csrfFromCookie,
  passwordChangeError,
  positiveInteger,
  slugify,
} from "./forms.ts";

test("slugify creates stable service identifiers", () => {
  assert.equal(slugify(" DeepSeek Chat ", "model"), "deepseek-chat");
  assert.equal(slugify("你好", "model"), "model");
});

test("positiveInteger rejects fractions and non-positive values", () => {
  assert.equal(positiveInteger("32", 8), 32);
  assert.equal(positiveInteger("1.5", 8), 8);
  assert.equal(positiveInteger("0", 8), 8);
});

test("csrf token is read without exposing other cookies", () => {
  assert.equal(csrfFromCookie("theme=light; antnest_csrf=csrf%2Dtoken; ignored=x"), "csrf-token");
});

test("Secure CSRF delivery takes precedence over a planted legacy cookie", () => {
  for (const cookie of [
    "__Host-antnest_csrf=bound-token",
    "antnest_csrf=planted; __Host-antnest_csrf=bound-token",
    "__Host-antnest_csrf=bound-token; antnest_csrf=planted",
  ]) assert.equal(csrfFromCookie(cookie), "bound-token");
});

test("ambiguous or malformed delivery never falls back to a legacy value", () => {
  for (const cookie of [
    "__Host-antnest_csrf=; antnest_csrf=legacy",
    "__Host-antnest_csrf=%zz; antnest_csrf=legacy",
    "__Host-antnest_csrf=first; __Host-antnest_csrf=second; antnest_csrf=legacy",
    "__Host-antnest_csrf =first; __Host-antnest_csrf=second",
    "antnest_csrf=first; antnest_csrf=second",
    "antnest_csrf=%zz",
  ]) assert.equal(csrfFromCookie(cookie), "");
});

test("password change validates credentials using the Identity byte limits", () => {
  assert.equal(passwordChangeError("", "replacement correct password", "replacement correct password"), "Enter your current password.");
  assert.equal(passwordChangeError("current password", "short", "short"), "Use at least 12 bytes for the new password.");
  assert.equal(passwordChangeError("current password", "replacement correct password", "different password"), "New passwords do not match.");
  assert.equal(passwordChangeError("current password", "replacement correct password", "replacement correct password"), "");
  assert.equal(passwordChangeError("current password", "密码密码", "密码密码"), "");
  assert.equal(passwordChangeError("current password", "x".repeat(1025), "x".repeat(1025)), "Use no more than 1024 bytes for the new password.");
});
