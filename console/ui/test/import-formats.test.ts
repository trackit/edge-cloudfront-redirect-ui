import { describe, expect, it } from "vitest";
import { detectFormat, parseExport } from "../src/domain/akamaiImport";
import type { SourceFormat } from "../src/domain/akamaiImport";
import { FORMAT_HELP, FORMAT_LABEL } from "../src/domain/importFormats";

/**
 * The Formats help is documentation that ships inside the product, so it is
 * checked against the parser rather than against a reviewer's memory.
 *
 * An example that no longer detects, or no longer imports, is worse than no
 * example: it is read at exactly the moment someone's own file failed to parse,
 * and it would send them off to match a shape the importer stopped accepting.
 */
describe("the Formats help examples", () => {
  it("covers every format the importer detects", () => {
    // Guards the tab list against a fifth format being added to the union and
    // going undocumented — the gap CF-32 found, where the help named three of
    // the four formats already implemented.
    const documented = FORMAT_HELP.map((help) => help.format).sort();
    const known = (Object.keys(FORMAT_LABEL) as SourceFormat[]).sort();

    expect(documented).toEqual(known);
  });

  it.each(FORMAT_HELP)(
    "detects its own example as $format",
    ({ format, filename, example }) => {
      expect(detectFormat({ filename, text: example })).toBe(format);
    },
  );

  it.each(FORMAT_HELP)(
    "imports at least one rule from its $format example",
    ({ filename, example }) => {
      // Detection only reads the header. This is the stronger claim: the body
      // of the example is a row the importer can actually turn into a rule.
      const preview = parseExport(example, {
        filename,
        defaultHost: "www.example.com",
      });

      expect(preview.rows.length).toBeGreaterThan(0);
      expect(preview.rows.some((row) => row.status !== "skipped")).toBe(true);
    },
  );

  it("labels every tab", () => {
    for (const help of FORMAT_HELP) {
      expect(FORMAT_LABEL[help.format]).toBeTruthy();
      expect(help.blurb).toBeTruthy();
    }
  });
});
