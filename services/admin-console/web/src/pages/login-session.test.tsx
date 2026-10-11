import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LoginPage } from "./login";
import { resetSessionRequests } from "../lib/api";
import * as login from "../lib/login";
import { testSession } from "../test/session-fixture";

afterEach(cleanup);

it.each(["generation", "cookie", "unmount"])("does not navigate an old OIDC response after %s changes at delivery", async boundary => {
  let complete!: (body: string) => void;
  const body = new Promise<string>(resolve => { complete = resolve; });
  const response = Response.json({});
  vi.spyOn(response, "text").mockReturnValue(body);
  vi.stubGlobal("fetch", vi.fn(async (path: string) => path === "/api/session/login-methods"
    ? Response.json({ methods: [{ name: "company", display_name: "Company SSO" }] })
    : response));
  const destination = vi.spyOn(login, "authorizationDestination").mockImplementation(() => { throw new Error("Navigation reached test boundary"); });
  const view = render(<LoginPage onLogin={() => undefined} />);
  fireEvent.click(await screen.findByRole("button", { name: /Company SSO/ }));
  await act(async () => { await Promise.resolve(); });
  expect(response.text).toHaveBeenCalledTimes(1);
  void body.then(() => {
    if (boundary === "generation") resetSessionRequests(testSession.principal);
    else if (boundary === "cookie") vi.spyOn(document, "cookie", "get").mockReturnValue("__Host-antnest_csrf=other-tab");
    else view.unmount();
  });
  await act(async () => complete(JSON.stringify({ authorization_url: "https://issuer.example.test/authorize", expires_at: "2026-10-12T00:00:00Z" })));
  expect(destination).not.toHaveBeenCalled();
});
