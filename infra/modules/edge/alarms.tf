# One alarm per region: Lambda@Edge writes its logs, and so the EMF metrics in
# them (infra/lambda/src/lib/geo-metrics.ts), in the region of the edge location
# that ran it, and an alarm only reads its own region. AWS provider 6 lets the
# one aliased provider place each alarm with `region`.
#
# The alarm compares the share of origin-request calls a country rule could
# apply to that arrived without a country to `geo_alarm_threshold`, rather than
# firing on any: CloudFront cannot place every address, so a few are normal.
resource "aws_cloudwatch_metric_alarm" "geo_country_missing" {
  for_each = toset(var.geo_alarm_regions)
  provider = aws.use1
  region   = each.value

  alarm_name          = "${var.function_name}-geo-country-missing"
  alarm_description   = "Country rules are being skipped: the viewer country does not reach origin-request. Check that the cache or origin request policies forward CloudFront-Viewer-Country."
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.geo_alarm_threshold
  evaluation_periods  = 3
  treat_missing_data  = "notBreaching"
  alarm_actions       = contains(keys(var.alarm_sns_topic_arns), each.value) ? [var.alarm_sns_topic_arns[each.value]] : []
  ok_actions          = contains(keys(var.alarm_sns_topic_arns), each.value) ? [var.alarm_sns_topic_arns[each.value]] : []
  tags                = var.tags

  metric_query {
    id          = "ratio"
    expression  = "IF(evaluated > 0, skipped / evaluated, 0)"
    label       = "Share of geo requests without a country"
    return_data = true
  }

  metric_query {
    id = "skipped"
    metric {
      namespace   = "EdgeRoute/Geo"
      metric_name = "CountryRulesSkipped"
      period      = 300
      stat        = "Sum"
      # A Lambda@Edge replica runs as `us-east-1.<name>` in every region.
      dimensions = { FunctionName = "us-east-1.${var.function_name}" }
    }
  }

  metric_query {
    id = "evaluated"
    metric {
      namespace   = "EdgeRoute/Geo"
      metric_name = "CountryRulesEvaluated"
      period      = 300
      stat        = "Sum"
      dimensions  = { FunctionName = "us-east-1.${var.function_name}" }
    }
  }
}
