/**
 * Guards the country picker's data, and one property above all: the picker must
 * never lose a code.
 *
 * A save rewrites the whole rule, so a code `groupCountries` declines to render
 * is a code the next save deletes. That is why nothing here validates a code
 * against the list — the list is what we offer, not what we accept — and why
 * the continent table, the only hand-written data in the feature, is checked
 * against the generated codes rather than trusted.
 */
import { describe, expect, it } from "vitest";
import { COUNTRY_CODES } from "../src/countries.gen";
import {
  CONTINENT_NAMES,
  OTHER_GROUP,
  codeFromQuery,
  continentOf,
  countryLabel,
  groupCountries,
  matchesCountryQuery,
} from "../src/countries";

const flatten = (extra: string[] = []): string[] =>
  groupCountries(extra).flatMap((group) => group.codes);

describe("the generated code list", () => {
  it("holds the whole world, not a truncated page", () => {
    // The generator throws below 200, so this is really a guard on the
    // committed file having been produced by it.
    expect(COUNTRY_CODES.length).toBeGreaterThan(200);
  });

  it.each(["FR", "DE", "US", "JP", "BR", "ZA"])("contains %s", (code) => {
    expect(COUNTRY_CODES).toContain(code);
  });

  it("is every code exactly once, in order", () => {
    expect(new Set(COUNTRY_CODES).size).toBe(COUNTRY_CODES.length);
    expect([...COUNTRY_CODES]).toEqual([...COUNTRY_CODES].sort());
  });
});

describe("the continent table", () => {
  it("places every generated code on a continent", () => {
    // The failure this exists for: a country AWS knows about that our
    // hand-written table forgot. It still appears, under "Other", so this is a
    // tidiness check rather than a correctness one — but an "Other" group with
    // forty countries in it is a table nobody maintained.
    const homeless = COUNTRY_CODES.filter((code) => !continentOf(code));
    expect(homeless).toEqual([]);
  });

  it("places no code on two continents", () => {
    const grouped = flatten();
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("invents no country the generated list does not have", () => {
    // A stale code left behind in the table after a regeneration would
    // otherwise be offered as a real country.
    const invented = flatten().filter(
      (code) => !COUNTRY_CODES.includes(code as never),
    );
    expect(invented).toEqual([]);
  });

  it.each([
    ["FR", "EU"],
    ["US", "NA"],
    ["JP", "AS"],
    ["BR", "SA"],
    // Namibia, whose code collides with North America's continent code. Worth
    // pinning: the two namespaces are easy to mix up when editing the table.
    ["NA", "AF"],
    // American Samoa, same collision with Asia's code.
    ["AS", "OC"],
  ])("puts %s in %s", (code, continent) => {
    expect(continentOf(code)).toBe(continent);
  });
});

describe("groupCountries", () => {
  it("labels each group with its continent name", () => {
    const labels = groupCountries().map((group) => group.label);
    expect(labels).toEqual(Object.values(CONTINENT_NAMES));
  });

  it("has no Other group when every code is known", () => {
    expect(groupCountries().map((g) => g.label)).not.toContain(OTHER_GROUP);
  });

  it("keeps a code it has never heard of, under Other and first", () => {
    // The whole resilience story in one assertion. "FF" is the typo from the
    // ticket's own discussion, and stands in equally for a country added to
    // CloudFront since this list was generated. First in the list because it is
    // the thing needing the user's attention.
    const groups = groupCountries(["FF"]);

    expect(groups[0]?.label).toBe(OTHER_GROUP);
    expect(groups[0]?.codes).toEqual(["FF"]);
    expect(flatten(["FF"])).toContain("FF");
  });

  it("does not duplicate an extra code it already knows", () => {
    const grouped = flatten(["FR"]);
    expect(grouped.filter((code) => code === "FR")).toEqual(["FR"]);
    expect(groupCountries(["FR"]).map((g) => g.label)).not.toContain(
      OTHER_GROUP,
    );
  });
});

describe("countryLabel", () => {
  it("names a country the platform knows", () => {
    expect(countryLabel("FR")).toBe("France");
  });

  it.each([
    // The reason this does not simply ask Intl: CLDR has names for codes that
    // are not countries, and showing them would be worse than showing nothing.
    ["ZZ", "CLDR calls it Unknown Region"],
    ["XA", "CLDR calls it Pseudo-Accents"],
    ["FF", "no name anywhere, and the typo from the ticket"],
  ])("shows %s as itself, because %s", (code) => {
    expect(countryLabel(code)).toBe(code);
  });

  it("does not throw on a malformed code", () => {
    // Reachable: the rule schema only enforces two uppercase letters, and this
    // reads whatever a stored rule holds.
    expect(() => countryLabel("")).not.toThrow();
    expect(countryLabel("")).toBe("");
  });
});

describe("matchesCountryQuery", () => {
  it.each([
    ["an empty query shows everything", "FR", "", true],
    ["by code", "FR", "FR", true],
    ["by lowercase code", "FR", "fr", true],
    ["by name", "FR", "fran", true],
    ["by name, any case", "DE", "GERM", true],
    ["by a name fragment in the middle", "GB", "kingdom", true],
    ["not by an unrelated query", "FR", "germ", false],
    ["not by a letter in neither the code nor the name", "FR", "z", false],
    // Prefix on the code, not substring: "J" is BJ's second letter, and Benin
    // has no J in its name either, so nothing matches. Without the prefix rule
    // a one-letter query would drag in a third of the world.
    ["not by a code fragment", "BJ", "j", false],
  ])("%s", (_label, code, query, expected) => {
    expect(matchesCountryQuery(code, query)).toBe(expected);
  });
});

describe("codeFromQuery", () => {
  it.each([
    ["two letters", "zz", "ZZ"],
    ["two letters, already uppercase", "ZZ", "ZZ"],
    ["two letters with spaces around", "  zz  ", "ZZ"],
  ])("offers %s", (_label, query, expected) => {
    expect(codeFromQuery(query)).toBe(expected);
  });

  it.each([
    ["one letter", "z"],
    ["three letters", "fra"],
    ["a name", "france"],
    ["digits", "12"],
    ["empty", ""],
  ])("offers nothing for %s", (_label, query) => {
    // Anything the rule schema's pattern would reject must not be offered:
    // suggesting a value that cannot be saved is worse than suggesting none.
    expect(codeFromQuery(query)).toBeUndefined();
  });
});
