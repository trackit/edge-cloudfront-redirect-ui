import { describe, expect, it, vi } from "vitest";
import {
  createSessionStore,
  expiryFrom,
  isFresh,
  RENEW_MARGIN_MS,
} from "../src/auth/session";

/**
 * Holding an access token in memory and renewing it in time.
 *
 * The two things worth protecting are that a token close to expiry is renewed
 * before it is used, and that concurrent callers share one renewal — four
 * requests on page load must not start four refreshes.
 */

const NOW = 1_000_000;

const store = (
  refresh: () => Promise<{ accessToken: string; expiresIn: number }>,
  now = () => NOW,
) => createSessionStore({ refresh }, now);

describe("isFresh", () => {
  it("is false with nothing held", () => {
    expect(isFresh(undefined, NOW)).toBe(false);
  });

  it("is true well before expiry", () => {
    expect(isFresh({ accessToken: "a", expiresAt: NOW + 600_000 }, NOW)).toBe(
      true,
    );
  });

  it("is false inside the renewal margin", () => {
    // A request that starts just under the wire can arrive just over it, and the
    // browser's clock is not AWS's. Renewing early costs nothing.
    const expiresAt = NOW + RENEW_MARGIN_MS - 1;

    expect(isFresh({ accessToken: "a", expiresAt }, NOW)).toBe(false);
  });

  it("is false once expired", () => {
    expect(isFresh({ accessToken: "a", expiresAt: NOW - 1 }, NOW)).toBe(false);
  });
});

describe("expiryFrom", () => {
  it("turns the API's seconds into an absolute time", () => {
    expect(expiryFrom(3600, NOW)).toBe(NOW + 3_600_000);
  });
});

describe("token", () => {
  it("refreshes when nothing is held", async () => {
    const store_ = store(() =>
      Promise.resolve({ accessToken: "a-1", expiresIn: 3600 }),
    );

    expect(await store_.token()).toBe("a-1");
  });

  it("reuses a fresh token instead of asking again", async () => {
    const refresh = vi
      .fn()
      .mockResolvedValue({ accessToken: "a-1", expiresIn: 3600 });
    const store_ = store(refresh);

    await store_.token();
    await store_.token();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("renews a token inside the margin", async () => {
    const refresh = vi
      .fn()
      .mockResolvedValueOnce({ accessToken: "a-1", expiresIn: 30 })
      .mockResolvedValueOnce({ accessToken: "a-2", expiresIn: 3600 });
    const store_ = store(refresh);

    expect(await store_.token()).toBe("a-1");
    // 30s of life is inside the 60s margin, so the next read renews.
    expect(await store_.token()).toBe("a-2");
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("returns nothing when there is no session, rather than throwing", async () => {
    // Signed out is the ordinary state for a first-time visitor, not an error.
    const store_ = store(() => Promise.reject(new Error("401")));

    expect(await store_.token()).toBeUndefined();
    expect(store_.current()).toBeUndefined();
  });
});

describe("concurrent callers", () => {
  it("share one refresh", async () => {
    // With refresh-token rotation on, four parallel refreshes invalidate each
    // other and log the user out. Even with it off, three of the four are waste.
    let resolve!: (value: { accessToken: string; expiresIn: number }) => void;
    const refresh = vi.fn(
      () =>
        new Promise<{ accessToken: string; expiresIn: number }>((r) => {
          resolve = r;
        }),
    );
    const store_ = store(refresh);

    const all = Promise.all([store_.token(), store_.token(), store_.token()]);
    resolve({ accessToken: "a-1", expiresIn: 3600 });

    expect(await all).toEqual(["a-1", "a-1", "a-1"]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("allows a new refresh once the first has settled", async () => {
    const refresh = vi
      .fn()
      .mockResolvedValue({ accessToken: "a-1", expiresIn: 3600 });
    const store_ = store(refresh);

    await store_.renew();
    await store_.renew();

    // The shared promise is only shared while it is in flight; a later renewal
    // must not be answered from a stale one.
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe("adopt", () => {
  it("takes a session without going back to the network", async () => {
    const refresh = vi.fn();
    const store_ = store(refresh);

    store_.adopt({ accessToken: "a-exchange", expiresIn: 3600 });

    expect(await store_.token()).toBe("a-exchange");
    // The code exchange already returned this. Asking again would be a second
    // round trip to learn what we were just told.
    expect(refresh).not.toHaveBeenCalled();
  });

  it("dates the token from the adopting clock", () => {
    const store_ = store(vi.fn());

    store_.adopt({ accessToken: "a-exchange", expiresIn: 3600 });

    expect(store_.current()).toEqual({
      accessToken: "a-exchange",
      expiresAt: NOW + 3_600_000,
    });
  });

  it("survives a refresh that fails after it", async () => {
    // The sign-in callback in one line. The page load starts a refresh that is
    // certain to 401 — there is no cookie yet — and the exchange lands while
    // that failure is still in the air. The late failure must not win.
    let reject!: (reason: Error) => void;
    const refresh = vi.fn(
      () =>
        new Promise<{ accessToken: string; expiresIn: number }>((_, r) => {
          reject = r;
        }),
    );
    const store_ = store(refresh);

    const booting = store_.token();
    store_.adopt({ accessToken: "a-exchange", expiresIn: 3600 });
    reject(new Error("no session"));

    // The boot read is answered with the adopted token rather than nothing,
    // because by the time it settles there genuinely is a session.
    expect(await booting).toBe("a-exchange");
    expect(store_.current()?.accessToken).toBe("a-exchange");
  });

  it("is not undone by a refresh that succeeds after a sign-out", async () => {
    let resolve!: (value: { accessToken: string; expiresIn: number }) => void;
    const refresh = vi.fn(
      () =>
        new Promise<{ accessToken: string; expiresIn: number }>((r) => {
          resolve = r;
        }),
    );
    const store_ = store(refresh);

    const booting = store_.token();
    store_.clear();
    resolve({ accessToken: "a-late", expiresIn: 3600 });

    await booting;
    expect(store_.current()).toBeUndefined();
  });
});

describe("clear", () => {
  it("drops the token so the next read refreshes", async () => {
    const refresh = vi
      .fn()
      .mockResolvedValue({ accessToken: "a-1", expiresIn: 3600 });
    const store_ = store(refresh);

    await store_.token();
    store_.clear();
    await store_.token();

    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
