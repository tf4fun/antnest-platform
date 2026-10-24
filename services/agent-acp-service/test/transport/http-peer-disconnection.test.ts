import { expect, it } from "vitest";
import { isDisconnectedHttpPeer } from "../../src/transport/http-peer-disconnection.js";

const coded = (code: string, cause?: unknown) =>
  Object.assign(new Error("private network details", cause === undefined ? {} : { cause }), {
    code,
  });

it.each(["ECONNREFUSED", "ECONNRESET"])(
  "recognizes the complete native %s cause without publishing it",
  (code) => {
    expect(isDisconnectedHttpPeer(coded(code))).toBe(true);
    expect(isDisconnectedHttpPeer(new TypeError("fetch failed", { cause: coded(code) }))).toBe(
      true,
    );
    expect(
      isDisconnectedHttpPeer(
        Object.assign(new AggregateError([coded(code), coded("ECONNRESET")], "connect"), { code }),
      ),
    ).toBe(true);
  },
);

it.each(["ETIMEDOUT", "ABORT_ERR", "ERR_TLS_CERT_ALTNAME_INVALID", "UND_ERR_SOCKET", "EACCES"])(
  "rejects %s even when mixed with a reset",
  (code) => {
    expect(isDisconnectedHttpPeer(coded(code))).toBe(false);
    expect(isDisconnectedHttpPeer(new TypeError("fetch failed", { cause: coded(code) }))).toBe(
      false,
    );
    expect(
      isDisconnectedHttpPeer(
        Object.assign(new AggregateError([coded("ECONNRESET"), coded(code)], "connect"), {
          code: "ECONNRESET",
        }),
      ),
    ).toBe(false);
  },
);

it("rejects forged, ambiguous, circular and over-budget causes", () => {
  for (const value of [
    undefined,
    "ECONNREFUSED",
    { code: "ECONNRESET" },
    new Error("ECONNRESET"),
    new Error("wrapper", { cause: coded("ECONNRESET") }),
    Object.assign(new AggregateError([], "empty"), { code: "ECONNRESET" }),
    Object.assign(
      new AggregateError(
        Array.from({ length: 17 }, () => coded("ECONNRESET")),
        "large",
      ),
      { code: "ECONNRESET" },
    ),
  ])
    expect(isDisconnectedHttpPeer(value)).toBe(false);
  const circular = coded("ECONNRESET");
  circular.cause = circular;
  expect(isDisconnectedHttpPeer(circular)).toBe(false);
  const concealed = coded("ECONNRESET");
  Object.defineProperty(concealed, "cause", {
    get() {
      throw new Error("getter");
    },
  });
  expect(isDisconnectedHttpPeer(concealed)).toBe(false);
  let deep: Error = coded("ECONNRESET");
  for (let n = 0; n < 10; n++) deep = new TypeError("wrapper", { cause: deep });
  expect(isDisconnectedHttpPeer(deep)).toBe(false);
});
