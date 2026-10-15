/**
 * Counts, per host, the origin-request calls a country rule could apply to and
 * how many of them came without a country — the silent failure where every geo
 * rule is skipped. Flushed as CloudWatch EMF at most once a minute per execution
 * environment, on the next request: one log line per request would put a
 * Lambda@Edge log bill on every cache miss. Counts held when an environment is
 * recycled are lost, which only makes the alarm slightly slower.
 *
 * Nothing about the viewer is recorded — no IP, URL, header or country.
 */

interface Counts {
  evaluated: number;
  skipped: number;
}

export interface GeoMetricsOptions {
  now?: () => number;
  flushEveryMs?: number;
  /**
   * Hosts tracked between flushes. The key comes from the viewer's Host header,
   * and behind a wildcard alternate domain every subdomain is a new one.
   */
  maxHosts?: number;
  emit?: (line: string) => void;
  /** `us-east-1.<name>` in a Lambda@Edge replica, which is what the alarm reads. */
  functionName?: string;
}

export class GeoMetrics {
  private counts = new Map<string, Counts>();
  private lastFlush: number;
  private readonly now: () => number;
  private readonly flushEveryMs: number;
  private readonly maxHosts: number;
  private readonly emit: (line: string) => void;
  private readonly functionName: string;

  constructor({
    now = Date.now,
    flushEveryMs = 60_000,
    maxHosts = 100,
    emit = (line: string) => console.log(line),
    functionName = process.env["AWS_LAMBDA_FUNCTION_NAME"] ?? "local",
  }: GeoMetricsOptions = {}) {
    this.now = now;
    this.flushEveryMs = flushEveryMs;
    this.maxHosts = maxHosts;
    this.emit = emit;
    this.functionName = functionName;
    this.lastFlush = now();
  }

  record(host: string, skipped: boolean): void {
    const key = host.toLowerCase();
    let entry = this.counts.get(key);
    if (!entry) {
      if (this.counts.size >= this.maxHosts) return;
      entry = { evaluated: 0, skipped: 0 };
      this.counts.set(key, entry);
    }
    entry.evaluated++;
    if (skipped) entry.skipped++;
  }

  flushIfDue(): void {
    if (this.now() - this.lastFlush >= this.flushEveryMs) this.flush();
  }

  flush(): void {
    const timestamp = this.now();
    for (const [host, { evaluated, skipped }] of this.counts) {
      this.emit(
        JSON.stringify({
          _aws: {
            Timestamp: timestamp,
            CloudWatchMetrics: [
              {
                Namespace: "EdgeRoute/Geo",
                Dimensions: [["FunctionName"], ["FunctionName", "Host"]],
                Metrics: [
                  { Name: "CountryRulesEvaluated", Unit: "Count" },
                  { Name: "CountryRulesSkipped", Unit: "Count" },
                ],
              },
            ],
          },
          FunctionName: this.functionName,
          Host: host,
          CountryRulesEvaluated: evaluated,
          CountryRulesSkipped: skipped,
        }),
      );
    }
    this.counts = new Map();
    this.lastFlush = timestamp;
  }
}
