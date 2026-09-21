import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The guard `akamaiImport`'s docblock opens with: "One bad row never fails the
 * batch. Every row is parsed under its own guard; a throw becomes a skipped row
 * with a reason, not a dead import."
 *
 * It lives in its own file because it mocks `validateDraft`, and the parser's
 * main suite needs the real one.
 *
 * What is pinned here is the *contract*, not a particular trigger. There is no
 * known input that makes the verdict throw today — the mappers are defensive and
 * `validateDraft` catches its own regex failures — which is exactly why this is
 * worth a test: the guard exists for the row nobody anticipated, and without one
 * the promise above is only a comment.
 */

const BAD_TARGET = "/throw-here";

vi.mock("../src/domain/ruleDraft", async () => {
  const actual = await vi.importActual<
    typeof import("../src/domain/ruleDraft")
  >("../src/domain/ruleDraft");

  return {
    ...actual,
    validateDraft: (draft: Parameters<typeof actual.validateDraft>[0]) => {
      if (draft.kind === "redirect" && draft.redirectURL.includes(BAD_TARGET)) {
        throw new TypeError("cannot read properties of undefined");
      }
      return actual.validateDraft(
        draft,
        [] as Parameters<typeof actual.validateDraft>[1],
      );
    },
  };
});

const { parseExport } = await import("../src/domain/akamaiImport");

const HOST = "www.example.com";

const csv = [
  "ruleName,matchURL,redirectURL,result.statusCode",
  "Fine before,/a,/dest-a,301",
  `Throws,/b,${BAD_TARGET},301`,
  "Fine after,/c,/dest-c,302",
].join("\n");

describe("a row whose verdict throws", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is skipped with a reason, and the rest of the file still imports", () => {
    const preview = parseExport(csv, {
      filename: "export.csv",
      defaultHost: HOST,
    });

    // The file is not blamed for one row.
    expect(preview.error).toBeUndefined();
    expect(preview.format).toBe("edge-redirector-csv");
    expect(preview.rows).toHaveLength(3);

    const [before, threw, after] = preview.rows;

    // The two good rows are untouched — priorities included, which is the thing
    // a mid-file bail would have silently renumbered.
    expect(before.status).not.toBe("skipped");
    expect(after.status).not.toBe("skipped");
    expect(before.input).toBeDefined();
    expect(after.input).toBeDefined();

    // The bad row is refused, says why, and offers nothing to import.
    expect(threw.status).toBe("skipped");
    expect(threw.input).toBeUndefined();
    expect(threw.blocked.join(" ")).toMatch(/could not be checked/);
    expect(threw.blocked.join(" ")).toMatch(
      /cannot read properties of undefined/,
    );

    // And the summary counts it as skipped rather than losing it.
    expect(preview.summary.skipped).toBe(1);
    expect(preview.summary.ready).toBe(2);
  });
});
