import { describe, expect, it } from "vitest";
import { CONSOLE_PATH, hostKey, hostPath } from "../src/hostRoutes";

/**
 * Where a host sits in a URL, and what counts as the same host.
 *
 * Both are one-liners, and both are load-bearing: `hostPath` builds every link
 * in the sidebar and every redirect, and `hostKey` decides whether the host in
 * the address bar is the host in the list.
 */

describe("hostPath", () => {
  it("addresses a host under the console", () => {
    expect(hostPath("www.example.com")).toBe(
      `${CONSOLE_PATH}/hosts/www.example.com`,
    );
  });

  it.each([
    ["a slash", "a/b", "a%2Fb"],
    ["a question mark", "a?b", "a%3Fb"],
    ["a hash", "a#b", "a%23b"],
    ["a space", "a b", "a%20b"],
    ["a percent", "a%b", "a%25b"],
  ])(
    "encodes %s, which would otherwise change the route",
    (_case, raw, encoded) => {
      // A host is one path segment. An unencoded `/` addresses a different route
      // entirely, and `?` or `#` cut the segment short — the API can hold a host
      // that is not the dots-and-letters the form encourages.
      expect(hostPath(raw)).toBe(`${CONSOLE_PATH}/hosts/${encoded}`);
    },
  );

  it("round-trips through the decoding React Router does", () => {
    // The component reads the param already decoded, so what goes into the URL
    // has to come back out unchanged or the host it renders is not the host it
    // was given.
    const awkward = "wéird host/with?everything#in-it";
    const segment = hostPath(awkward).slice(`${CONSOLE_PATH}/hosts/`.length);

    expect(decodeURIComponent(segment)).toBe(awkward);
  });
});

describe("hostKey", () => {
  it("is the identity the API stores", () => {
    expect(hostKey("Shop.Example.COM")).toBe("shop.example.com");
  });

  it("leaves an already-normalized host alone", () => {
    expect(hostKey("shop.example.com")).toBe("shop.example.com");
  });

  it("is idempotent, so normalizing twice cannot drift", () => {
    // The route param is normalized on every render, and the redirect target is
    // built from the result — a second pass that changed anything would be a
    // redirect loop.
    const once = hostKey("WWW.Example.com");
    expect(hostKey(once)).toBe(once);
  });

  it("does not trim, because that is the form's job", () => {
    // The add-host field trims before it submits. Doing it here as well would
    // mean a URL with a stray space quietly addressing a different host than the
    // one it names.
    expect(hostKey(" shop.example.com ")).toBe(" shop.example.com ");
  });
});
