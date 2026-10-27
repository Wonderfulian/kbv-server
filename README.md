# Korea Business Verify (KBV) — MCP Server

[![M8ven Score](https://m8ven.ai/badge/mcp/wonderfulian/kbv-server)](https://m8ven.ai/mcp/wonderfulian/kbv-server?s=readme) [![M8ven Verified](https://m8ven.ai/badge/mcp/wonderfulian/kbv-server?variant=verified)](https://m8ven.ai/mcp/wonderfulian/kbv-server?s=readme)

**KBV is a hosted MCP server that finds and verifies Korean businesses in real time — about 10 free calls/day, then pay-per-call (x402).**

**You only need the company name.** Search `"Samsung Electronics"` — in English or Korean — and KBV returns the matching companies with their 10-digit business registration numbers (사업자등록번호), ranked by confidence. That matters because every other Korean business API assumes you already have the number, which a foreign agent almost never does. The index covers **940,000 companies**: every DART disclosure filer (with English names) plus every vendor registered for public procurement, so small businesses are in it too, not just conglomerates.

With a number in hand, KBV returns registration status (active / suspended / closed), tax type, and — optionally — whether the number matches a representative name and opening date. Data comes live from the Korea National Tax Service (NTS) and is returned as clean, English-normalized JSON.

**Shipping goods into Korea?** Give KBV a 10-digit HS code (or up to 100 of them) and it returns what Korean customs requires before clearance: the statutes, the agencies that can approve, the certificate to obtain, and each requirement's condition quoted from the governing notice — see [Import requirements](#check_korea_import_requirements).

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
| Price | **About 10 free calls/day** per IP (approximate, not strictly enforced), then pay-per-call via x402 ($0.02–$0.05) — see [Pricing](#pricing) |
| Tools | `find_korean_business`, `check_korean_business_status`, `check_korean_business_batch`, `verify_korean_business`, `check_korea_import_requirements`, `check_korea_import_requirements_batch` |
| REST API | `GET /v1/business/search` · `GET /v1/business/{number}/status` · `POST /v1/business/verify` · `POST /v1/business/batch` · `GET /v1/korea-import/requirements` · `POST /v1/korea-import/requirements/batch` — see [REST API](#rest-api) |
| Name index | 940,000 companies — DART disclosure filers (English names included) + registered public-procurement vendors |
| Screening | Batch calls also return public-procurement debarments (부정당업자 제재) per company |
| Data source | Public data from the Korea National Tax Service (국세청), read live per request through the government open-data portal (data.go.kr); name index from DART (금융감독원) and the Public Procurement Service (조달청); import requirements from the Korea Customs Service (관세청) and the Ministry of Government Legislation (법제처). KBV is independent and not affiliated with any of them — see [Data source and license](#data-source-and-license) |
| Data license | Korean government open data, **no usage restrictions** (이용허락범위 제한 없음) |
| Privacy | KBV logs no query contents; numbers, search terms and HS codes in GET URLs reach cloud access logs (14-day retention) — see [Privacy](#privacy) |
| Discovery | [`/.well-known/x402`](https://kbv-server-f7vfitmlkq-du.a.run.app/.well-known/x402) · [`/llms.txt`](https://kbv-server-f7vfitmlkq-du.a.run.app/llms.txt) |
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

### `find_korean_business`

Find a company by name when you do not know its registration number — the starting point for everything else here.

**Input:**

```json
{ "name": "Samsung Electronics" }
```

**Output** (real example, abbreviated) — candidates, never one confident guess:

```json
{
  "query": "Samsung Electronics",
  "candidates": [
    {
      "business_number": "1248100998",
      "name": "삼성전자",
      "name_en": "SAMSUNG ELECTRONICS CO,.LTD",
      "confidence": 1,
      "match": { "type": "exact", "field": "name_en" },
      "evidence": { "status": "active", "tax_type": "general", "listed": true }
    },
    {
      "business_number": "6178117517",
      "name": "삼성전자판매",
      "confidence": 0.75,
      "match": { "type": "prefix", "field": "name" },
      "evidence": { "status": "active", "tax_type": "general", "listed": false }
    }
  ],
  "note": "4 companies match this name equally well; they are distinct legal entities. Compare the evidence fields before acting."
}
```

- **Korean or English.** Legal-form noise is ignored: `Samsung Electronics`, `SAMSUNG ELECTRONICS CO,.LTD` and `삼성전자(주)` all match the same company.
- **`confidence`** reflects how the name matched (`exact` > `prefix` > `contains`), nudged by source and listing status. `match` tells you which field matched, so the score is never a black box.
- **`evidence`** is what separates similarly named companies: live registration status, tax type, region (city/district), and whether the company is listed.
- **A name can be ambiguous** — `"Samsung Electronics"` legitimately matches four distinct legal entities. KBV returns them all with a `note` rather than picking one.
- **No match returns `candidates: []` with a note saying so.** That is an answer, not an error: a lookup failure returns HTTP 503 with an `error` field instead.

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

- Each entry also carries **`sanctions`** — public-procurement debarments (부정당업자 제재) on record for that company, with `active` marking one in force today. A company can be perfectly active and still barred from public contracts, and `summary.sanctioned` counts how many of your list are. An empty array means screened and clear; the field being **absent** means this server has no debarment data loaded — not the same thing.
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

### `check_korea_import_requirements`

What Korean customs requires before it will clear a product, by its 10-digit Korean HS (HSK) code. Goods that need an approval they do not have are held or returned at the border.

**Input:**

```json
{ "hs_code": "8516710000", "direction": "import" }
```

- `hs_code`: 10 digits; dots, hyphens and spaces are fine. **6 digits** returns the 10-digit codes under that subheading to choose from — requirements differ between them, so KBV does not guess.
- `direction`: `"import"` (default, goods entering Korea) or `"export"`.
- Invalid codes are refused **before** any lookup or payment (`400 hs_code_not_found`). An unknown code is never answered as "no requirements".
- **`8516710000` (coffee makers) is a free test code**: full response, no allowance used — three statutes and five alternative agencies in one answer.

**Output** (abridged from the real response for `8516710000`):

```json
{
  "hs_code": "8516710000",
  "item_name_en": "Coffee or tea makers",
  "hs_code_valid": true,
  "requirements_checked": true,
  "has_requirements": true,
  "requirement_count": 3,
  "requirements": [
    {
      "statute_name_en": "Electrical Appliances and Consumer Products Safety Control Act",
      "statute_name_ko": "전기용품 및 생활용품 안전관리법",
      "certificate_name_ko": "전기용품 및 생활용품 요건확인서",
      "certificate_name_en": null,
      "certificate_name_en_unofficial": "Requirement confirmation for electrical appliances and consumer products",
      "approving_agencies": [
        { "code": "105", "name_ko": "국가기술표준원", "name_en": "Korean Agency for Technology and Standards" },
        { "code": "257", "name_ko": "한국화학융합시험연구원", "name_en": "Korea Testing & Research Institute" }
      ],
      "agencies_note": "Any one of the listed agencies may issue this certificate.",
      "condition": {
        "text_ko": "[전기용품 및 생활용품 안전관리법]\n. 정격전압이 30V초과 1000V이하의 교류전원 …",
        "text_en_unofficial": null,
        "granularity": "hs10",
        "source": { "notice_no": "제2026-46호", "effective_from": "2026-07-16", "url": "https://www.law.go.kr/행정규칙/…" }
      }
    }
  ],
  "governing_notice": {
    "notice_no": "제2026-46호",
    "index": { "notice_serial": "2100000282502", "last_checked_at": "2026-10-23T01:56:51Z", "check_status": "current" }
  },
  "attribution": "Source: Ministry of Government Legislation (법제처), law.go.kr",
  "tariff": {
    "source_as_of": "2026-02-11",
    "rates": [
      { "type": "A", "type_meaning": "Basic rate (기본세율)", "rate": "8" },
      { "type": "C", "type_meaning": "WTO concession rate (WTO 협정에 의한 양허관세)", "rate": "16" }
    ]
  },
  "source": "Korea Customs Service (KCS)",
  "disclaimer": "Fact lookup from public data. Not a legal customs determination. …"
}
```

How to read it:

- **One requirement = one statute + one certificate.** The customs API returns one row per approving agency; KBV groups them, so the coffee maker's seven rows are three requirements, and the electrical-safety one lists five agencies — **any one of them** can issue the certificate.
- **`condition.text_ko` is quoted verbatim** from the customs designation notice and is authoritative. KBV does not translate it (`text_en_unofficial` is always `null`): these clauses set legal thresholds — voltage ranges, capacity limits, scope carve-outs — where a mistranslation would make you skip a certificate you need. KBV also **does not decide whether a condition applies to your product**; only you know its voltage, use or composition.
- `granularity: "hs10"` means the condition is the notice's row for this exact code. When no such row exists, KBV falls back to the statute's row in the notice body (`"statute_group"`, with `items_ko` pairing each scope with its documents) and says that it is coarser.
- `governing_notice.index` tells you which revision of the notice the conditions come from and when KBV last confirmed with law.go.kr that it is still the one in force (checked daily). `check_status: "check_overdue"` means that confirmation is three or more days old — open the notice before relying on the conditions.
- Korean names are authoritative: use `name_ko` when you contact an agency or request a certificate. English agency names appear only where the agency itself publishes one; certificate names have no official English and are marked `_unofficial`.
- **Tariff**: rates as published in the Korea Customs Service file dated `source_as_of`. Only rate types `A` (basic) and `C` (WTO concession) are named; other codes are returned as-is, with a link to the [source dataset](https://www.data.go.kr/data/15051179/fileData.do). Exports carry no tariff.

**Four states, never confused:**

| Situation | Response |
|---|---|
| Valid code, requirements found | `200`, `requirements: [...]` |
| Valid code, **no** requirements | `200`, `requirements: []` and a note that this is a definitive result (e.g. bolts, `7318152000`) |
| Invalid code | `400 hs_code_not_found` (or `hs_code_incomplete` with candidates) — nothing looked up, nothing charged |
| Customs API unreachable | `503 upstream_unavailable` with `requirements_checked: false` — **not** "no requirements". Item name and tariff are still returned. Nothing charged. |

**Free vs paid.** The free tier (`?free=1` on REST) tells you whether the code is restricted and how many requirements it has, plus item name and tariff (`"detail": "summary"`). Statutes, agencies, certificates and the quoted conditions are the paid response. MCP tool calls return the full response within the free allowance.

### `check_korea_import_requirements_batch`

Screen a product catalog in one call: **up to 100 HS codes**, same per-code schema as above.

**Input:**

```json
{ "hs_codes": ["8516710000", "7318152000", "8471300000", "9999999999"], "direction": "import" }
```

**Output** (abridged):

```json
{
  "direction": "import",
  "results": [
    { "hs_code": "8516710000", "has_requirements": true, "requirement_count": 3, "requirements": ["…"] },
    { "hs_code": "8471300000", "has_requirements": true, "requirements": ["…"] },
    { "hs_code": "7318152000", "has_requirements": false, "requirements": [] }
  ],
  "summary": {
    "total": 4, "checked": 3, "with_requirements": 2, "clear": 1, "failed": 0, "duplicates_merged": 0,
    "invalid_hs": [{ "index": 3, "input": "9999999999", "error": "hs_code_not_found", "message": "Not a current 10-digit Korean HS (HSK) code." }]
  },
  "governing_notice": { "…": "…" },
  "attribution": "Source: Ministry of Government Legislation (법제처), law.go.kr",
  "disclaimer": "…"
}
```

- **Restricted codes come first**, then codes that could not be checked, then clear ones — read the top of the list and you have seen what customs will stop. A code that could not be checked is never placed among the clear ones.
- **Invalid codes do not fail the call.** They are listed in `summary.invalid_hs` (with the 10-digit candidates for a 6-digit input), are not looked up and **are not charged**. A batch with no valid code at all is a free `400 no_valid_hs_codes`.
- Duplicates are looked up and charged once. Fields that would repeat on every item (notice, attribution, disclaimer) are stated once at the top.
- Billing: **$0.02 per valid code actually looked up** (the client authorizes $2.00; settlement is the actual usage). A code whose lookup failed is returned with `requirements_checked: false` and is not charged. The test code `8516710000` is free here too.

## REST API

The same operations are available as plain HTTP endpoints — same JSON schemas as the MCP tools, no auth. **Append `?free=1` to use the daily free tier** (approximately 10 lookups per IP per day); without the flag, unpaid requests return `402` with x402 payment requirements:

```bash
# Find a company by name — the free tier returns names, numbers and confidence
curl -G "https://kbv-server-f7vfitmlkq-du.a.run.app/v1/business/search" \
  --data-urlencode "q=Samsung Electronics" --data-urlencode "free=1"

# Registration status (hyphens in the number are fine)
curl "https://kbv-server-f7vfitmlkq-du.a.run.app/v1/business/124-81-00998/status?free=1"

# KYB identity check
curl -X POST "https://kbv-server-f7vfitmlkq-du.a.run.app/v1/business/verify?free=1" \
  -H "Content-Type: application/json" \
  -d '{"business_number":"124-81-00998","representative_name":"홍길동","opening_date":"1969-01-13"}'

# Batch status check (up to 100 numbers)
curl -X POST "https://kbv-server-f7vfitmlkq-du.a.run.app/v1/business/batch?free=1" \
  -H "Content-Type: application/json" \
  -d '{"business_numbers":["124-81-00998","220-81-62517"]}'

# Import requirements for one HS code — the test code returns the full answer free
curl "https://kbv-server-f7vfitmlkq-du.a.run.app/v1/korea-import/requirements?hs_code=8516710000"

# Any other code: ?free=1 gives the summary (restricted or not, how many requirements, tariff)
curl "https://kbv-server-f7vfitmlkq-du.a.run.app/v1/korea-import/requirements?hs_code=7318152000&free=1"

# Exports: add direction=export
curl "https://kbv-server-f7vfitmlkq-du.a.run.app/v1/korea-import/requirements?hs_code=8516710000&direction=export"

# Screen a catalog (up to 100 codes; invalid ones are reported, not charged)
curl -X POST "https://kbv-server-f7vfitmlkq-du.a.run.app/v1/korea-import/requirements/batch?free=1" \
  -H "Content-Type: application/json" \
  -d '{"hs_codes":["8516710000","7318152000","9999999999"]}'
```

HTTP status codes: `200` success (including cache-served results), `400` invalid input, `402` payment required (no `?free=1`, or the daily free tier is exhausted — pay per call via x402), `503` upstream (NTS or Korea Customs Service) temporarily unavailable with no cached result.

## Errors

Errors are returned as MCP tool errors (or REST 4xx/5xx responses) with a machine-readable JSON body:

| `error` | Meaning |
|---|---|
| `invalid_business_number` | The business number is not 10 digits. Nothing was queried. |
| `invalid_opening_date` | (verify) `opening_date` is not `YYYY-MM-DD`. The number itself was not the problem. Nothing was queried. |
| `batch_limit_exceeded` | More than 100 numbers (or HS codes) in one batch call. Nothing was queried. |
| `invalid_request` | (REST only) The request body does not match the expected shape. |
| `upstream_unavailable` | The NTS or Korea Customs Service API is down or over quota and no cached result exists. Retry later. For import requirements this is never a "no requirements" answer (`requirements_checked: false`). |
| `hs_code_not_found` | Not a current 10-digit Korean HS code. Nothing was looked up or charged. |
| `hs_code_incomplete` | A 6-digit subheading: the response lists the 10-digit `candidates`. Choose one and ask again. Nothing was charged. |
| `no_valid_hs_codes` | (import batch) None of the submitted codes is valid; `invalid_hs` says why for each. Nothing was charged. |
| `hs_master_unavailable` | The HS code table could not be loaded, so codes cannot be validated. Retry shortly. Nothing was charged. |

## Data source and license

- **KBV is an independent service.** It is not operated, endorsed or affiliated with the Korea National Tax Service (국세청), the Korea Customs Service (관세청), the Public Procurement Service (조달청), the Financial Supervisory Service (금융감독원, DART) or the Ministry of Government Legislation (법제처). It reads their public open data and says so in every response.
- **Where the data comes from:**
  - **Registration status, tax type, identity match** — Korea National Tax Service (국세청) business registration service on data.go.kr (사업자등록정보 진위확인 및 상태조회 서비스), queried **live on every request**. KBV keeps no copy of NTS registration data beyond the 24-hour outage cache described under Privacy.
  - **Name index** (`find_korean_business`) — KBV's own index built from DART disclosure filers (Financial Supervisory Service, 금융감독원) and vendors registered with the Public Procurement Service (조달청). When a DART filer's business number is not yet in the index, it is looked up from DART at search time.
  - **Debarment records** (batch) — KBV's own copy of the Public Procurement Service (조달청) sanctions list (부정당업자 제재); no external call at request time.
  - **Import requirements** — see the next bullets.
- The underlying dataset is published under the Korean government open-data policy with **no usage restrictions** (이용허락범위: 제한 없음), so responses may be used commercially and cited freely.
- KBV normalizes the Korean-language, code-based NTS responses into the stable English JSON schema documented above; raw NTS payloads are never passed through.
- Freshness: queries hit the NTS registry directly. Newly registered businesses may take 1–2 business days to appear in the NTS system itself.
- **Import requirements** come live from the Korea Customs Service requirements API. Conditions are quoted from the customs designation notice (관세법 제226조 지정고시) published by the **Ministry of Government Legislation** (법제처, law.go.kr) — every response that quotes them carries the attribution `Source: Ministry of Government Legislation (법제처), law.go.kr`. The notice is checked daily for amendments and the condition index is rebuilt when it changes. HS codes and item names: Korea Customs Service HS code table (data.go.kr 15049722); tariff rates: [관세청_품목번호별 관세율표](https://www.data.go.kr/data/15051179/fileData.do) (data.go.kr 15051179), published yearly.

## Privacy

- **KBV's own logs never contain query contents.** The service writes only event counts, outcomes, and latency — never business numbers, names, addresses, search terms or HS codes.
- **Where your inputs go.** Each tool sends an upstream only what that upstream needs to answer:

  | Tool / route | Sent to | What is sent |
  |---|---|---|
  | `check_korean_business_status` · `GET /v1/business/{number}/status` | Korea National Tax Service, `api.odcloud.kr` | the business number |
  | `verify_korean_business` · `POST /v1/business/verify` | Korea National Tax Service, `api.odcloud.kr` | business number, representative name, opening date, and the address if you give one |
  | `check_korean_business_batch` · `POST /v1/business/batch` | Korea National Tax Service, `api.odcloud.kr` | the business numbers (debarment records come from KBV's own copy) |
  | `find_korean_business` · `GET /v1/business/search` | **DART**, `opendart.fss.or.kr` — and Korea National Tax Service, `api.odcloud.kr` | **Your search term is not sent anywhere**; it is matched against KBV's own index. For the matching companies: DART receives a candidate's DART company code (`corp_code`) when KBV does not yet hold its business number, and the NTS receives the candidates' business numbers when the response includes evidence (every MCP call; paid REST calls) |
  | `check_korea_import_requirements` · `..._batch` · `/v1/korea-import/requirements` | Korea Customs Service, `apis.data.go.kr` | the HS code(s) and the direction (import/export) |

  A DART company code identifies a company, so DART can see which companies' numbers were looked up — not the words you typed. KBV also reads its own index files from Google Cloud Storage in its own project; no query data is written there.
- **One exception, inherent to HTTP:** the three GET endpoints carry their input in the URL — `GET /v1/business/{number}/status` the business number, `GET /v1/business/search?q=` the company name or number you search for, `GET /v1/korea-import/requirements?hs_code=` the HS code you look up — so it appears in the platform access log that Google Cloud Run records for every request. Those entries are retained for **14 days**, then deleted automatically. KBV cannot mask a single field inside them: Cloud Logging filters whole entries, it does not rewrite them.
- **Not affected:** `POST /v1/business/verify`, `POST /v1/business/batch`, `POST /v1/korea-import/requirements/batch` and all MCP tool calls (including `find_korean_business` and `check_korea_import_requirements`) send their inputs in the request body, which access logs do not record. Prefer these if you would rather no identifier, search term or HS code appear in any log.
- For context, a Korean business registration number is a public company identifier rather than personal data — though a sole proprietorship is registered to an individual, so the distinction above is worth knowing.
- A short-lived in-memory cache (24 h max, hashed keys) exists solely so the service can answer during NTS outages; it is never shared or exported.

## Pricing

- **The number `124-81-00998` is free and unlimited.** Samsung Electronics — a real, listed company — is exempt from the daily allowance, so wiring up a client costs you nothing. Live NTS data, not a fixture.
- **Free tier: approximately 10 lookups per IP per day** (a batch call counts one per number), resetting at 00:00 UTC. The counter lives in server memory: it is per server instance and resets whenever the service is redeployed, so treat the number as approximate, not strictly enforced. No account or key is needed. MCP tools use it automatically; REST calls opt in by appending **`?free=1`** — without the flag, REST answers `402` with x402 payment requirements. MCP and REST share the same counter.
- **Finding is free, confirming is paid.** `GET /v1/business/search?q=…&free=1` returns names, business numbers and confidence within the free tier — an agent that only knows a company name can always reach a number. The paid call adds the `evidence` fields (status, tax type, region, listing) that separate similarly named companies.
- Beyond the free tier, the REST endpoints are **pay-per-call via the [x402](https://www.x402.org/) protocol** (USDC on Base mainnet, agent-payable — no signup):
  - `GET /v1/business/search` — **$0.02** (candidates with evidence)
  - `GET /v1/business/{number}/status` — **$0.02**
  - `POST /v1/business/verify` — **$0.05**
  - `POST /v1/business/batch` — **$0.02 per number** (authorize up to $2.00, settled at actual usage)
  - `GET /v1/korea-import/requirements` — **$0.03** (with `?free=1`, a summary: item name, tariff, whether the code is restricted and how many requirements; the paid call adds statutes, approving agencies, certificates and the quoted conditions. HS code `8516710000` is always free and complete)
  - `POST /v1/korea-import/requirements/batch` — **$0.02 per valid HS code looked up** (authorize up to $2.00, settled at actual usage; invalid codes, failed lookups and `8516710000` are not charged)
- Over-quota MCP tool calls return a `free_tier_exceeded` error that points to the paid REST endpoints above.
- Fair use: the upstream NTS quota is shared; the free tier keeps light usage free while heavy traffic moves to paid calls.

## FAQ

**I only know the company's name — can I still use this?** Yes, and that is the point of `find_korean_business` (or `GET /v1/business/search`). Give it a name in English or Korean and it returns the matching companies with their registration numbers, ranked by confidence. Every other tool here needs the number; this is how you get it.

**Does name search cover small companies, or only conglomerates?** Both. The index combines DART disclosure filers (~119k, nearly all with English names) with every vendor registered for public procurement (~821k), which is where small and mid-sized Korean companies appear.

**What is a Korean business registration number?** A 10-digit identifier (사업자등록번호, often written `123-45-67890`) issued by the Korea National Tax Service to every registered business in South Korea.

**Can I check whether a Korean company is still operating?** Yes — call `check_korean_business_status`; `"status": "active"` means the business is currently registered and operating, `"closed"` includes the closure date.

**Can I verify a Korean company's identity before a transaction (KYB)?** Yes — call `verify_korean_business` with the number, representative name, and opening date; `identity_match: true` means the NTS confirms all three match.

**Can I screen a whole supplier list at once?** Yes — `check_korean_business_batch` (or `POST /v1/business/batch`) takes up to 100 numbers per call and returns per-number registration status **and any public-procurement debarment**, plus a summary counting how many are currently barred. That combination is the actual screening question: a supplier can be operating normally and still be barred from public contracts.

**Can I test without burning my free calls?** Yes. Queries for `124-81-00998` (Samsung Electronics) never count against the daily allowance, on any endpoint or tool — including inside a batch, where only the other numbers are billed. The response is live NTS data.

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
