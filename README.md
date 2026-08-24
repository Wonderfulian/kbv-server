# Korea Business Verify (KBV)

**KBV is a remote MCP server that verifies Korean businesses.** Give it a 10-digit Korean business registration number (사업자등록번호) and it returns the registration status (active / suspended / closed), tax type, and — optionally — whether the number matches a representative name and opening date. Data comes from the Korea National Tax Service (NTS) in real time and is returned as clean, English-normalized JSON.

Built for AI agents and developers doing KYB / due-diligence on Korean companies: procurement, contracting, payments, marketplace onboarding.

## Quick start (local)

```bash
cp .env.example .env       # put your data.go.kr DECODING key in NTS_SERVICE_KEY
npm install
npm run dev                # → http://localhost:8080
```

- MCP endpoint: `POST /mcp` (Streamable HTTP transport)
- Health check: `GET /health`

Connect with MCP Inspector: `npx @modelcontextprotocol/inspector`, transport **Streamable HTTP**, URL `http://localhost:8080/mcp`.

> Note: Streamable HTTP clients must send `Accept: application/json, text/event-stream`. MCP Inspector and Claude connectors do this automatically; a plain `curl` without those headers will be rejected by the transport.

## Tools

### `check_korean_business_status`

Check the registration status of a Korean business by its 10-digit business registration number.

**Input**

```json
{ "business_number": "123-45-67890" }
```

Hyphens and spaces are allowed; the number is normalized internally.

**Output**

```json
{
  "business_number": "1234567890",
  "status": "active",
  "status_code_raw": "01",
  "tax_type": "general",
  "closed_date": null,
  "checked_at": "2026-08-22T09:00:00.000Z",
  "source": "Korea National Tax Service (NTS)",
  "cache": false
}
```

- `status`: `active` | `suspended` | `closed` | `not_registered`
- `tax_type`: `general` | `simplified` | `exempt` | `non_profit` | `unknown`
- `closed_date`: ISO date, only for closed businesses
- `cache`: `true` only when the NTS API was unavailable and a cached result (max 24h old) was served; `checked_at` then reflects the original fetch time

### `verify_korean_business`

Verify that a business registration number matches the provided representative name and opening date (KYB identity check), and get the current status in the same call.

**Input**

```json
{
  "business_number": "123-45-67890",
  "representative_name": "홍길동",
  "opening_date": "1999-05-01",
  "address": "서울특별시 강남구 테헤란로 1"
}
```

`address` is optional and improves match precision. Names and addresses should be given as registered with the NTS (Korean).

**Output**: same schema as above, plus `"identity_match": true | false`.

## Errors

Errors are returned as MCP tool errors with a JSON body:

- `invalid_business_number` — input is not a 10-digit number (or the date is not `YYYY-MM-DD`); nothing was queried
- `upstream_unavailable` — the NTS API is down/over quota and no cached result exists; retry later

## Privacy & logging

Query contents (business numbers, names, addresses) are never logged and never sent anywhere except the official NTS API. Logs contain request counts, outcomes, and latency only.

## Development

```bash
npm test           # vitest, upstream fully mocked — no network
npm run typecheck
npm run build && npm start
```

Deployment guide (Google Cloud Run): see [DEPLOY.md](DEPLOY.md).
