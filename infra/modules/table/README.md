# `table` — DynamoDB rules table (ER-101)

Reusable Terraform module that creates the DynamoDB table the Lambda@Edge reads
routing rules from. The table is the only interface between the control plane
(writes rules) and the data plane (reads rules at the edge).

## Schema

| Key  | Attr | Type   | Meaning                                              |
| ---- | ---- | ------ | ---------------------------------------------------- |
| Hash | `pk` | String | Host, e.g. `www.example.com`                         |
| Range| `sk` | String | `TYPE#priority`, zero-padded — e.g. `REDIRECT#00100` |

- Billing: `PAY_PER_REQUEST` (on-demand).
- Point-in-time recovery: enabled.
- Single region — Global Tables are out of scope for the MVP.

## Usage

```hcl
module "table" {
  source     = "./modules/table"
  table_name = "edgeroute-redirect-rules"
  region     = "us-east-1" # optional; defaults to the provider region
}
```

## Inputs

| Name                  | Type          | Default | Description                                                    |
| --------------------- | ------------- | ------- | -------------------------------------------------------------- |
| `table_name`          | `string`      | —       | Table name. Any valid DynamoDB name (3–255 `[a-zA-Z0-9_.-]`). |
| `region`              | `string`      | `null`  | Table region. `null` → provider region.                       |
| `deletion_protection` | `bool`        | `true`  | Deletion protection on the table.                             |
| `tags`                | `map(string)` | `{}`    | Tags applied to the table.                                    |

## Outputs

| Name           | Description                                    |
| -------------- | ---------------------------------------------- |
| `table_name`   | Table name.                                    |
| `table_arn`    | Table ARN — for the Lambda@Edge IAM read policy. |
| `table_region` | Region the table lives in.                     |

## Tests

```bash
terraform init -backend=false
terraform test   # runs tests/table.tftest.hcl against a mock AWS provider (no creds)
```

## Requirements

- Terraform `>= 1.7`
- AWS provider `~> 6.0` (per-resource `region` argument)
