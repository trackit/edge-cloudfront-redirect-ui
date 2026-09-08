// CloudFront Function (viewer-request) for the console distribution.
//
// Read verbatim by Terraform, so this is plain JavaScript with nothing
// interpolated into it. Keep the syntax to what the cloudfront-js runtime
// accepts: no let/const in older runtimes, no String.startsWith, no optional
// chaining. The logic lives in one function because CloudFront allows only one
// viewer-request function per cache behavior, and this one is attached to both.
//
// Two jobs, in order:
//   1. Strip the /api prefix. The console calls /api/... so the browser stays
//      same-origin (the API sends no CORS headers), but the API itself serves
//      /health, not /api/health.
//   2. Serve the SPA for client-side routes, so /console and a deep link both
//      return index.html instead of an S3 error.
//
// This function decides nothing about who may do what. A basic-auth prompt used
// to sit here, from when login was post-MVP: it stood in front of the bundle and
// the login page, neither of which holds anything secret, and it could not stand
// in front of /api at all once the console's bearer token needed the same
// header. Cognito and the JWT authorizer on the HTTP API do that job.

// Anything vite emits with a hashed filename. Requests here are real files and
// must not be rewritten to index.html, or a missing asset would answer 200 with
// a page in place of the script that was asked for.
var ASSET_PREFIX = "/assets/";

// Extensions served straight from the bucket when they sit at the root, e.g.
// /favicon.svg. Deliberately an allowlist: "the last segment has a dot" would
// break the console's own routes, since /console/hosts/d111.cloudfront.net ends
// in what looks like an extension.
var STATIC_EXTENSIONS = [
  ".html",
  ".js",
  ".css",
  ".svg",
  ".png",
  ".ico",
  ".json",
  ".txt",
  ".map",
  ".woff2",
];

function isStaticFile(uri) {
  if (uri.indexOf(ASSET_PREFIX) === 0) return true;

  for (var i = 0; i < STATIC_EXTENSIONS.length; i++) {
    var ext = STATIC_EXTENSIONS[i];
    if (
      uri.length >= ext.length &&
      uri.indexOf(ext, uri.length - ext.length) !== -1
    ) {
      return true;
    }
  }

  return false;
}

function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // The API paths, forwarded with the prefix removed and nothing else done to
  // them. "/api" with nothing after it becomes "/", which the API answers as an
  // unknown route rather than as /api.
  if (uri === "/api" || uri === "/api/") {
    request.uri = "/";
    return request;
  }

  if (uri.indexOf("/api/") === 0) {
    request.uri = uri.substring(4);
    return request;
  }

  // "/" is left alone: the distribution's default root object serves index.html.
  if (uri !== "/" && !isStaticFile(uri)) {
    request.uri = "/index.html";
  }

  return request;
}
