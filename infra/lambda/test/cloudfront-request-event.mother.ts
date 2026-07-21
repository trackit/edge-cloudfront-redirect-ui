import type {
  CloudFrontEvent,
  CloudFrontHeaders,
  CloudFrontRequest,
  CloudFrontRequestEvent,
} from "aws-lambda";

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

    this.request = {
      clientIp: "1.2.3.4",
      method: "GET",
      uri: "/test",
      querystring: "",
      headers: {
        host: [{ key: "Host", value: "www.example.com" }],
      },
      origin:
        eventType === "origin-request"
          ? {
              s3: {
                authMethod: "origin-access-identity",
                domainName: "original-bucket.s3.amazonaws.com",
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

  build(): CloudFrontRequestEvent {
    return {
      Records: [{ cf: { config: this.config, request: this.request } }],
    };
  }
}
