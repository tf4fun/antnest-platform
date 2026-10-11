import { afterEach, beforeEach, vi } from "vitest";
import { resetSessionRequests } from "../lib/api";
import type { Session } from "../lib/types";

// Components outside App render inside an already validated browser session.
// Tests exercising login, expiry or cross-tab changes override this fixture.
export const testSession: Session = {
  principal: {
    user_id: "admin-1", organization_id: "org-1", membership_id: "membership-1",
    organization_slug: "test", organization_name: "Test organization",
    system_role: "admin", organization_role: "admin", active: true,
  },
  expires_at: "2026-10-12T00:00:00Z", idle_expires_at: "2026-10-11T12:30:00Z", activity_interval_ms: 30000,
};

beforeEach(() => {
  vi.spyOn(document, "cookie", "get").mockReturnValue("__Host-antnest_csrf=synthetic-test-session");
  resetSessionRequests(testSession.principal);
});
afterEach(() => resetSessionRequests());
