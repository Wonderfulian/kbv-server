/**
 * Discovery documents that agents and crawlers ask for by convention.
 *
 * Both were being answered with 404 while bots asked for them daily — about
 * 39 requests in four days from x402 trust indexes, catalog crawlers and
 * agent-web indexers (enclave402, Agent402, 402explorer, GolemreachTrustBot).
 * They were knocking on a door that did not exist.
 *
 *   /.well-known/x402   the x402 capability manifest, per the IETF draft
 *                       (draft-hawkins-x402-dns-discovery): one HTTPS GET
 *                       takes a bare domain to verified payment capability
 *   /llms.txt           the plain-text orientation file an LLM reads before
 *                       deciding whether a service is worth calling
 *
 * Both are free and unmetered: a discovery document behind a paywall defeats
 * its own purpose.
 */

export const BASE_URL = 'https://kbv-server-f7vfitmlkq-du.a.run.app';
const REPO_URL = 'https://github.com/Wonderfulian/kbv-server';

/** One x402-gated route, as the manifest advertises it. */
export interface ManifestResource {
  url: string;
  method: string;
  description: string;
  accepts: { scheme: string; network: string; price: string; payTo: string }[];
}

export interface X402Manifest {
  x402Version: number;
  kind: 'resource-server';
  name: string;
  description: string;
  resources: ManifestResource[];
  docs: string;
  updated: string;
}

/**
 * Builds the manifest from the same route table the payment middleware uses,
 * so a price can never drift between the 402 response and the manifest.
 */
export function buildX402Manifest(input: {
  routes: Record<string, { description?: string; accepts: { scheme: string; price: string; network: string; payTo: string }[] }>;
  updated: string;
}): X402Manifest {
  const resources: ManifestResource[] = Object.entries(input.routes).map(([key, route]) => {
    const [method, path] = key.split(' ');
    return {
      url: `${BASE_URL}${path}`,
      method,
      description: route.description ?? '',
      accepts: route.accepts.map((a) => ({
        scheme: a.scheme,
        network: a.network,
        price: a.price,
        payTo: a.payTo,
      })),
    };
  });

  return {
    x402Version: 2,
    kind: 'resource-server',
    name: 'Korea Business Verify (KBV)',
    description:
      'Find Korean companies by name and verify them against the National Tax Service: registration status, ' +
      'tax type, KYB identity match, and public-procurement debarment screening.',
    resources,
    docs: REPO_URL,
    updated: input.updated,
  };
}

/**
 * Orientation file for LLMs and agent crawlers. Written to be read once and
 * acted on: what this service answers, how to call it, what it costs, and the
 * one thing that sets it apart — you do not need the registration number.
 */
export const LLMS_TXT = `# Korea Business Verify (KBV)

> Hosted MCP server and REST API that finds Korean companies by name and verifies them against official
> Korea National Tax Service (NTS) data. 10 free calls per day per IP, then pay-per-call via x402.
> No account, no API key, no installation.

Most Korean business APIs require the 10-digit business registration number (사업자등록번호) up front.
KBV does not: give it a company name in English or Korean and it returns the matching companies with
their numbers. The name index covers about 940,000 companies — every DART disclosure filer (English
names included) plus every vendor registered for public procurement, so small businesses are covered
too, not only conglomerates.

Base URL: ${BASE_URL}

## What it answers

- Which company is this name? Ranked candidates with their registration numbers and a confidence score.
- Is this company currently registered — active, suspended, or closed — and what is its tax type?
- Does this number match a given representative name and opening date? (KYB identity check)
- Is anyone on this supplier list barred from public contracts? (부정당업자 제재 screening)

All responses are English-normalized JSON with ISO 8601 dates.

## MCP (for AI agents)

- Endpoint (Streamable HTTP, POST): ${BASE_URL}/mcp
- Tools: find_korean_business, check_korean_business_status, check_korean_business_batch, verify_korean_business
- Example prompts:
  - "Find the Korean business registration number for Samsung Electronics."
  - "Check the status of Korean business 124-81-00998."
  - "Screen these 40 supplier numbers and tell me which are closed or barred from public contracts."

## REST API

Append ?free=1 to use the daily free tier. Without it, an unpaid request returns 402 with x402 payment
requirements (USDC on Base mainnet, agent-payable, no signup).

- GET ${BASE_URL}/v1/business/search?q={name} — ranked candidates. Free tier returns name, number and
  confidence; a paid call adds evidence (status, tax type, region, listed).
- GET ${BASE_URL}/v1/business/{number}/status — registration status and tax type. Hyphens allowed.
- POST ${BASE_URL}/v1/business/verify — body: {"business_number","representative_name","opening_date","address"?}
  — returns the status fields plus "identity_match": true|false.
- POST ${BASE_URL}/v1/business/batch — body: {"business_numbers": [...]} up to 100. Returns one entry per
  number plus any public-procurement debarment, and a summary counting how many are currently barred.

Status codes: 200 success, 400 invalid input, 402 payment required, 503 upstream unavailable.
An empty search result is 200 with "candidates": [] and a note — that is an answer, not a failure.

## Free testing

The number 124-81-00998 (Samsung Electronics, a real public company) is exempt from the daily free tier:
query it as often as you like while wiring up an integration, without spending your 10 free calls.

Example:

    curl "${BASE_URL}/v1/business/search?q=Samsung%20Electronics&free=1"
    curl "${BASE_URL}/v1/business/124-81-00998/status"

## Pricing

- 10 free lookups per IP per day, resetting 00:00 UTC. MCP tools use it automatically; REST opts in with ?free=1.
- Paid: search $0.02, status $0.02, verify $0.05, batch $0.02 per number. Payment via the x402 protocol.

## Privacy and data source

- KBV's own logs never contain query contents. A number passed in a GET URL does appear in the cloud
  provider's access log for 14 days; POST and MCP calls send inputs in the request body and are not logged.
- Data source: Korea National Tax Service official open-data API, queried live per request. Name index from
  DART (Financial Supervisory Service) and the Public Procurement Service. Korean government open data,
  no usage restrictions.

## Docs

- [GitHub repository and full README](${REPO_URL})
- [Health check](${BASE_URL}/health)
`;
