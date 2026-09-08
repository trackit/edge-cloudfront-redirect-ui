import { describe, expect, it } from "vitest";
import { readCookie } from "../src/lib/read-cookie.js";

/**
 * Reading one cookie out of the header that carries them all. The cases that
 * matter are the ones that used to make a cookie condition misbehave: a name
 * that is a prefix or suffix of another, a value that contains the name being
 * looked for, and a missing cookie.
 */
const HEADER = "session=a1b2c3; region=london; consent=none; ab_test=on";

describe("readCookie", () => {
  it.each([
    { name: "session", value: "a1b2c3" },
    { name: "region", value: "london" },
    { name: "ab_test", value: "on" },
  ])("reads $name", ({ name, value }) => {
    expect(readCookie(HEADER, name)).toBe(value);
  });

  it.each([
    { what: "a cookie that is not there", name: "missing" },
    { what: "a name that is a prefix of another", name: "ab" },
    { what: "a name that is a suffix of another", name: "test" },
    { what: "no name at all", name: "" },
  ])("returns nothing for $what", ({ name }) => {
    expect(readCookie(HEADER, name)).toBe("");
  });

  it("is case-sensitive, as cookie names are", () => {
    expect(readCookie(HEADER, "AB_TEST")).toBe("");
  });

  it("keeps a value that contains = or looks like a pair", () => {
    expect(readCookie("token=a=b=c; x=1", "token")).toBe("a=b=c");
  });

  it("reads the first cookie when there is no leading space", () => {
    expect(readCookie("only=1", "only")).toBe("1");
  });

  it("survives a header with junk between the separators", () => {
    expect(readCookie("nonsense; ab_test=on", "ab_test")).toBe("on");
  });

  it("returns nothing for an empty header", () => {
    expect(readCookie("", "ab_test")).toBe("");
  });
});
