import type { ErrorObject } from "ajv";

/**
 * Plain-language messages for the country rules of the shared schema.
 *
 * They are all `if`/`then` constraints, and Ajv words those by mechanism, not by
 * meaning — "must NOT be valid" on the field, plus "must match \"then\" schema"
 * on its parent. Correct, and useless to someone calling the API. Matched on the
 * keyword and the field rather than on `schemaPath`, which moves whenever the
 * schema is reorganised.
 */
const MESSAGES: { keyword: string; field: RegExp; message: string }[] = [
  {
    keyword: "not",
    field: /^\/matches\/\d+\/matchType$/,
    message:
      "cannot be header, cookie or protocol on a redirect that also checks the country: the redirect runs at origin-request, where those may be missing, and a negated one would match every viewer",
  },
  {
    keyword: "const",
    field: /^\/matches\/\d+\/negate$/,
    message:
      'cannot be true on a country condition: exclude countries with matchOperator "notEquals" instead',
  },
  {
    keyword: "not",
    field: /^\/matches\/\d+\/matchOperator$/,
    message:
      '"notEquals" is only for a country condition: use negate to invert this one',
  },
];

/**
 * Rewords the errors above, and drops the `if` errors that only restate them.
 * Any other error, `if` ones included, is left exactly as Ajv wrote it.
 */
export const explainCountryErrors = (
  errors: ErrorObject[] | null | undefined,
): ErrorObject[] => {
  const all = errors ?? [];
  let explained = false;

  const reworded = all.map((error) => {
    const known = MESSAGES.find(
      (m) => m.keyword === error.keyword && m.field.test(error.instancePath),
    );
    if (known === undefined) return error;
    explained = true;
    return { ...error, message: known.message };
  });

  return explained
    ? reworded.filter((error) => error.keyword !== "if")
    : reworded;
};
