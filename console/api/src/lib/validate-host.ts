import { Ajv } from "ajv";
import { ApiError } from "./errors.js";
import { formatAjvErrors } from "./ajv-errors.js";

export interface HostInput {
  host: string;
}

/**
 * A host as it is stored — the DynamoDB partition key.
 *
 * DNS is case-insensitive and a partition key is not, so without one definition
 * of "the same host" `Shop.example.com` and `shop.example.com` are two hosts:
 * two entries in the console's list, two partitions, and only one of them ever
 * matched by a request. Every path that turns a host into a key goes through
 * here — see `router.ts`, which applies it to the `:host` path param so no
 * handler can forget.
 */
export const hostKey = (host: string): string => host.toLowerCase();

const ajv = new Ajv({ allErrors: true, useDefaults: false });

/**
 * A hostname, not a URL. The console's add-host field says as much, and users
 * paste `https://shop.example.com/` into it anyway — so the pattern refuses a
 * scheme, a port, a path and a trailing dot rather than storing them as part of
 * the partition key, where they would match no request the edge ever sees.
 *
 * Labels of letters, digits and hyphens, separated by dots, hyphen never first
 * or last in a label. 253 is the maximum length of a DNS name.
 */
const LABEL = "[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?";

const validate = ajv.compile<HostInput>({
  type: "object",
  additionalProperties: false,
  required: ["host"],
  properties: {
    host: {
      type: "string",
      maxLength: 253,
      pattern: `^${LABEL}(\\.${LABEL})*$`,
    },
  },
});

/**
 * Validates an add-host body `{ host }`. Throws
 * `ApiError(400, "VALIDATION_ERROR", …)` naming `/host`. Returns the host
 * lowercased: DNS is case-insensitive but a DynamoDB partition key is not, so
 * `Shop.example.com` and `shop.example.com` would otherwise be two hosts, only
 * one of which the edge can ever match.
 */
export const validateHost = (body: unknown): string => {
  if (!validate(body)) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Host failed validation",
      formatAjvErrors(validate.errors),
    );
  }

  return hostKey(body.host);
};
