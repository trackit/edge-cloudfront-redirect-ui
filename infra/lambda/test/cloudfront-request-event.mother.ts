import type {
  CloudFrontEvent,
  CloudFrontHeaders,
  CloudFrontRequest,
  CloudFrontRequestEvent,
} from "aws-lambda";
import { VIEWER_COUNTRY_HEADER } from "../src/lib/viewer-country.js";
import { VIEWER_HOST_HEADER } from "../src/lib/viewer-host.js";

const ORIGIN_DOMAIN = "original-bucket.s3.amazonaws.com";
const VIEWER_HOST = "www.example.com";

export class CloudfrontRequestEventMother {
  private request: CloudFrontRequest;
  private config: CloudFrontEvent["config"];

  private constructor(eventType: CloudFrontEvent["config"]["eventType"]) {
    this.config = {
      distributionId: "EXAMPLE",
      distributionDomainName: "example.cloudfront.net",
      eventType,
      requestId: "test-request-id",
    };

    const isOriginRequest = eventType === "origin-request";

    this.request = {
      clientIp: "1.2.3.4",
      method: "GET",
      uri: "/test",
      querystring: "",
      // By origin-request CloudFront has replaced Host with the origin's own
      // domain, and the viewer's hostname only survives because viewer-request
      // stamped it. Modelling that faithfully is the point: a fixture that puts
      // the viewer's host in `host` at origin-request describes an event
      // CloudFront cannot produce, and a lookup keyed on the wrong header passes.
      headers: isOriginRequest
        ? {
            host: [{ key: "Host", value: ORIGIN_DOMAIN }],
            [VIEWER_HOST_HEADER]: [
              { key: "X-EdgeRoute-Viewer-Host", value: VIEWER_HOST },
            ],
          }
        : { host: [{ key: "Host", value: VIEWER_HOST }] },
      origin: isOriginRequest
        ? {
            s3: {
              authMethod: "origin-access-identity",
              domainName: ORIGIN_DOMAIN,
              path: "",
              customHeaders: {},
              region: "us-east-1",
            },
          }
        : undefined,
    };
  }

  static viewerRequest(): CloudfrontRequestEventMother {
    return new CloudfrontRequestEventMother("viewer-request");
  }

  static originRequest(): CloudfrontRequestEventMother {
    return new CloudfrontRequestEventMother("origin-request");
  }

  /** For event types the Lambda is not associated with. */
  static forEventType(
    eventType: CloudFrontEvent["config"]["eventType"],
  ): CloudfrontRequestEventMother {
    return new CloudfrontRequestEventMother(eventType);
  }

  withUri(uri: string): this {
    this.request.uri = uri;
    return this;
  }

  withQuerystring(querystring: string): this {
    this.request.querystring = querystring;
    return this;
  }

  withHeaders(headers: CloudFrontHeaders): this {
    this.request.headers = { ...this.request.headers, ...headers };
    return this;
  }

  withHost(host: string): this {
    this.request.headers["host"] = [{ key: "Host", value: host }];
    return this;
  }

  /** A viewer sending the header itself, or viewer-request having stamped it. */
  withViewerHostHeader(host: string): this {
    this.request.headers[VIEWER_HOST_HEADER] = [
      { key: "X-EdgeRoute-Viewer-Host", value: host },
    ];
    return this;
  }

  /** A distribution with no viewer-request association: nothing stamped it. */
  withoutViewerHostHeader(): this {
    delete this.request.headers[VIEWER_HOST_HEADER];
    return this;
  }

  /**
   * The country header. CloudFront only ever sets this itself, and only from
   * origin-request onwards, so putting it on a viewer-request event describes a
   * viewer that sent the name itself — which is exactly the case worth testing,
   * since the handler must ignore it there.
   */
  withViewerCountry(country: string): this {
    this.request.headers[VIEWER_COUNTRY_HEADER] = [
      { key: "CloudFront-Viewer-Country", value: country },
    ];
    return this;
  }

  build(): CloudFrontRequestEvent {
    return {
      Records: [{ cf: { config: this.config, request: this.request } }],
    };
  }
}
