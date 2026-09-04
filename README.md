# Korea Business Verify (KBV) — MCP Server

[![M8ven Score](https://m8ven.ai/badge/mcp/wonderfulian-kbv-server-nnj5uy)](https://m8ven.ai/mcp/wonderfulian-kbv-server-nnj5uy)

**KBV is a hosted MCP server that verifies Korean businesses in real time — 10 free calls/day, then pay-per-call (x402).** Give it a 10-digit Korean business registration number (사업자등록번호) and it returns the registration status (active / suspended / closed), tax type, and — optionally — whether the number matches a representative name and opening date. Data comes live from the Korea National Tax Service (NTS) and is returned as clean, English-normalized JSON.

No account, no API key, no installation — connect any MCP-capable agent to one URL:

```
https://kbv-server-f7vfitmlkq-du.a.run.app/mcp
```

Built for AI agents and developers doing KYB / due-diligence on Korean companies: procurement, contracting, payments, marketplace onboarding.

## Quick facts

| | |
|---|---|
| MCP endpoint | `https://kbv-server-f7vfitmlkq-du.a.run.app/mcp` |
| Transport | MCP Streamable HTTP (`POST`) |
| Health check | `GET https://kbv-server-f7vfitmlkq-du.a.run.app/health` → `{"ok":true}` |
| Authentication | None required |
| Price | **10 free calls/day** per IP, then pay-per-call via x402 ($0.02–$0.05) — see [Pricing](#pricing) |
| Tools | `check_korean_business_status`, `check_korean_business_batch`, `verify_korean_business` |
| REST API | `GET /v1/business/{number}/status` · `POST /v1/business/verify` · `POST /v1/business/batch` — see [REST API](#rest-api) |
| Data source | Korea National Tax Service (국세청), official open-data API — queried live per request |
| Data license | Korean government open data, **no usage restrictions** (이용허락범위 제한 없음) |
| Privacy | Query contents are never logged — see [Privacy](#privacy) |
| Region | Google Cloud Run, Seoul (asia-northeast3) |

## Connect your agent

### Claude (claude.ai)

1. **Settings → Connectors → Add custom connector**
2. URL: `https://kbv-server-f7vfitmlkq-du.a.run.app/mcp`
3. Enable the connector in a chat and ask: *"Check the status of Korean business 124-81-00998."*

### Claude Code (CLI)

```bash
claude mcp add --transport http kbv https://kbv-server-f7vfitmlkq-du.a.run.app/mcp
```

### ChatGPT

1. **Settings → Connectors** (requires a plan with connector / developer-mode support)
2. Add a custom MCP connector with URL `https://kbv-server-f7vfitmlkq-du.a.run.app/mcp`
3. Enable it in a conversation and ask about a Korean business number.

### Cursor

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "korea-business-verify": {
      "url": "https://kbv-server-f7vfitmlkq-du.a.run.app/mcp"
    }
  }
}
```

### Any other MCP client

Use transport **Streamable HTTP** with the endpoint above. Clients must send `Accept: application/json, text/event-stream` (standard MCP clients do this automatically). Opening `/mcp` in a browser returns `Method not allowed` by design — browsers send `GET`, MCP uses `POST`. Use `/health` for a visual liveness check.

## Tools

### `check_korean_business_status`

Check the registration status of a Korean business by its 10-digit business registration number.

**Input** — hyphens/spaces allowed; normalized internally:

```json
{ "business_number": "124-81-00998" }
```

**Output** (real example — Samsung Electronics):

```json
{
  "business_number": "1248100998",
  "status": "active",
  "status_code_raw": "01",
  "tax_type": "general",
  "closed_date": null,
  "checked_at": "2026-08-24T10:08:20.082Z",
  "source": "Korea National Tax Service (NTS)",
  "cache": false
}
```

**Field reference:**

- `status`: `active` | `suspended` | `closed` | `not_registered`
- `tax_type`: `general` | `simplified` | `exempt` | `non_profit` | `unknown`
- `closed_date`: ISO date (`"2023-01-31"`), only for closed businesses, otherwise `null`
- `checked_at`: ISO 8601 UTC timestamp of the NTS query
- `cache`: `true` only when the NTS API was temporarily unavailable and a cached result (max 24 h old) was served; `checked_at` then reflects the original fetch time

A number that is well-formed but not registered with the NTS returns `"status": "not_registered"` (not an error).

### `check_korean_business_batch`

Check **up to 100 businesses in a single call** — for screening supplier or customer lists without 100 round-trips.

**Input:**

```json
{ "business_numbers": ["124-81-00998", "220-81-62517"] }
```

**Output** — one entry per input number (order preserved, same schema as above) plus a summary:

```json
{
  "results": [
    { "business_number": "1248100998", "status": "active", "...": "..." },
    { "business_number": "2208162517", "status": "active", "...": "..." }
  ],
  "summary": { "total": 2, "active": 2, "suspended": 0, "closed": 0, "not_registered": 0 }
}
```

- The whole batch is answered with **one** upstream NTS query.
- Numbers checked within the last 24 hours may be served from cache (marked `"cache": true` with their original `checked_at`) and are excluded from the upstream query.
- More than 100 numbers, or any malformed number, is rejected **before** anything is queried.

### `verify_korean_business`

Verify that a business registration number matches the provided representative name and opening date (KYB identity check), and get the current status in the same call.

**Input:**

```json
{
  "business_number": "124-81-00998",
  "representative_name": "홍길동",
  "opening_date": "1969-01-13",
  "address": "경기도 수원시"
}
```

- `representative_name` and `opening_date` (`YYYY-MM-DD`) are required.
- `address` is optional and improves match precision.
- Names and addresses should be given as registered with the NTS (Korean script).

**Output** — same schema as above plus `identity_match`:

```json
{
  "business_number": "1248100998",
  "status": "active",
  "status_code_raw": "01",
  "tax_type": "general",
  "closed_date": null,
  "checked_at": "2026-08-24T10:08:23.483Z",
  "source": "Korea National Tax Service (NTS)",
  "cache": false,
  "identity_match": false
}
```

`identity_match` is `true` only when the NTS confirms that the number, representative name, and opening date all match its records.

## REST API

The same three operations are available as plain HTTP endpoints — same JSON schemas as the MCP tools, no auth:

```bash
# Registration status (hyphens in the number are fine)
curl https://kbv-server-f7vfitmlkq-du.a.run.app/v1/business/124-81-00998/status

# KYB identity check
curl -X POST https://kbv-server-f7vfitmlkq-du.a.run.app/v1/business/verify \
  -H "Content-Type: application/json" \
  -d '{"business_number":"124-81-00998","representative_name":"홍길동","opening_date":"1969-01-13"}'

# Batch status check (up to 100 numbers)
curl -X POST https://kbv-server-f7vfitmlkq-du.a.run.app/v1/business/batch \
  -H "Content-Type: application/json" \
  -d '{"business_numbers":["124-81-00998","220-81-62517"]}'
```

HTTP status codes: `200` success (including cache-served results), `400` invalid input, `503` NTS temporarily unavailable with no cached result.

## Errors

Errors are returned as MCP tool errors (or REST 4xx/5xx responses) with a machine-readable JSON body:

| `error` | Meaning |
|---|---|
| `invalid_business_number` | Input is not a 10-digit number, or the date is not `YYYY-MM-DD`. Nothing was queried. |
| `batch_limit_exceeded` | More than 100 numbers in one batch call. Nothing was queried. |
| `invalid_request` | (REST only) The request body does not match the expected shape. |
| `upstream_unavailable` | The NTS API is down or over quota and no cached result exists. Retry later. |

## Data source and license

- All data comes from the **Korea National Tax Service (국세청)** via the official Korean government open-data API (data.go.kr: 사업자등록정보 진위확인 및 상태조회 서비스), queried **live on every request** — KBV stores no business database.
- The underlying dataset is published under the Korean government open-data policy with **no usage restrictions** (이용허락범위: 제한 없음), so responses may be used commercially and cited freely.
- KBV normalizes the Korean-language, code-based NTS responses into the stable English JSON schema documented above; raw NTS payloads are never passed through.
- Freshness: queries hit the NTS registry directly. Newly registered businesses may take 1–2 business days to appear in the NTS system itself.

## Privacy

- **Query contents are never logged.** Business numbers, representative names, and addresses appear in no server logs and are sent nowhere except the official NTS API that answers the query.
- Server logs contain only request counts, outcomes, and latency metrics.
- A short-lived in-memory cache (24 h max, hashed keys) exists solely so the service can answer during NTS outages; it is never shared or exported.

## Pricing

- **Free tier: 10 lookups per IP per day** (a batch call counts one per number), resetting at 00:00 UTC. No account or key is needed. MCP and REST share the same counter.
- Beyond the free tier, the REST endpoints are **pay-per-call via the [x402](https://www.x402.org/) protocol** (USDC on Base mainnet, agent-payable — no signup):
  - `GET /v1/business/{number}/status` — **$0.02**
  - `POST /v1/business/verify` — **$0.05**
  - `POST /v1/business/batch` — **$0.02 per number** (authorize up to $2.00, settled at actual usage)
- Over-quota MCP tool calls return a `free_tier_exceeded` error that points to the paid REST endpoints above.
- Fair use: the upstream NTS quota is shared; the free tier keeps light usage free while heavy traffic moves to paid calls.

## FAQ

**What is a Korean business registration number?** A 10-digit identifier (사업자등록번호, often written `123-45-67890`) issued by the Korea National Tax Service to every registered business in South Korea.

**Can I check whether a Korean company is still operating?** Yes — call `check_korean_business_status`; `"status": "active"` means the business is currently registered and operating, `"closed"` includes the closure date.

**Can I verify a Korean company's identity before a transaction (KYB)?** Yes — call `verify_korean_business` with the number, representative name, and opening date; `identity_match: true` means the NTS confirms all three match.

**Can I screen a whole supplier list at once?** Yes — `check_korean_business_batch` (or `POST /v1/business/batch`) takes up to 100 numbers per call and returns per-number results plus a summary.

**Do I need an API key?** No. Connect to the MCP URL and call the tools, or call the REST endpoints directly.

## Self-hosting / development

The server is open for local development (Node.js ≥ 22, TypeScript, Express + official MCP SDK):

```bash
cp .env.example .env       # put your own data.go.kr DECODING key in NTS_SERVICE_KEY
npm install
npm run dev                # → http://localhost:8080  (MCP at /mcp)
npm test                   # vitest, upstream fully mocked — no network
```

Deployment guide (Google Cloud Run): see [DEPLOY.md](DEPLOY.md). Architecture and design spec: [DESIGN.md](DESIGN.md).
