import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api";
import type { HostSummary } from "../src/api";
import { resolveHostView, toHostsError } from "../src/hosts";

/**
 * The host list's two decisions, both reachable without a DOM: what a failed
 * load is shown as, and which of the console's three views a loaded list plus
 * the addressed host add up to.
 *
 * The view decision is the console's routing, so the order its cases are tested
 * in is the behaviour — an empty target, a URL naming no host, and a URL naming
 * one that is not there are three different answers, and getting the order wrong
 * is how `hosts[0]` is read from an empty list.
 */

const host = (name: string, over: Partial<HostSummary> = {}): HostSummary => ({
  host: name,
  redirects: 0,
  rewrites: 0,
  ...over,
});

describe("toHostsError", () => {
  it("passes an ApiError through untouched", () => {
    // The server described the refusal; nothing here can improve on it.
    const refusal = new ApiError({
      status: 404,
      code: "UNKNOWN_TARGET",
      message: "No such target",
    });

    expect(toHostsError(refusal)).toBe(refusal);
  });

  it.each([
    ["a rejected fetch", new TypeError("Failed to fetch")],
    ["a string", "boom"],
    ["null", null],
    ["undefined", undefined],
    ["an object that is not an error", { message: "nope" }],
  ])("turns %s into one sentence a user can read", (_case, thrown) => {
    // Anything not already an ApiError is a transport fault rather than a
    // refusal the server explained, and carries nothing worth showing.
    const error = toHostsError(thrown);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("MALFORMED_RESPONSE");
    expect(error.status).toBe(0);
    expect(error.message).toBe("Something went wrong loading the hosts");
  });
});

describe("resolveHostView", () => {
  it("is the empty view when the target has no hosts", () => {
    expect(resolveHostView([], null)).toEqual({ kind: "empty" });
  });

  it("is the empty view even when the URL names a host", () => {
    // A link to a host in a target that has none: there is nothing to show and
    // nothing to redirect to, and "No such host" beside an empty rail would be
    // two ways of saying the same thing.
    expect(resolveHostView([], "www.example.com")).toEqual({ kind: "empty" });
  });

  it("redirects to the first host when the URL names none", () => {
    expect(
      resolveHostView([host("a.example.com"), host("b.example.com")], null),
    ).toEqual({ kind: "redirect", to: "a.example.com" });
  });

  it("takes the list's own order, which the API sorted", () => {
    // Not re-sorted here: the server returns hosts by name, and picking a
    // different first host than the sidebar shows at the top would land the user
    // somewhere other than where they were looking.
    expect(
      resolveHostView([host("z.example.com"), host("a.example.com")], null),
    ).toEqual({ kind: "redirect", to: "z.example.com" });
  });

  it("shows an addressed host that is in the list", () => {
    expect(
      resolveHostView(
        [host("www.example.com", { redirects: 2 }), host("shop.example.com")],
        "shop.example.com",
      ),
    ).toEqual({ kind: "host", host: "shop.example.com", known: true });
  });

  it("still shows an addressed host that is not in the list, as unknown", () => {
    // A stale link, or a host someone else deleted. Saying so beats an empty
    // pane that reads as a host with no rules.
    expect(
      resolveHostView([host("www.example.com")], "gone.example.com"),
    ).toEqual({ kind: "host", host: "gone.example.com", known: false });
  });

  it("matches exactly, leaving normalization to the caller", () => {
    // `hostKey` is applied to the route param before this sees it. Lowercasing
    // again here would hide a caller that forgot, and the API's stored host is
    // already normalized, so a mismatch in case means a genuine mismatch.
    expect(
      resolveHostView([host("www.example.com")], "WWW.Example.com"),
    ).toMatchObject({ known: false });
  });
});
