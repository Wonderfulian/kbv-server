# Security

## Known advisories in dependencies (as of 2026-10-27)

`npm audit --omit=dev` reports 10 high-severity entries. Eight of them trace to one advisory in
`zod`; two are separate advisories, listed at the end. What follows is what was checked, and how.

### GHSA-mrhx-c7xc-m3w5 — zod: memory exhaustion validating oversized constrained collections

- **Affected:** `zod < 4.6.6`. **Patched:** `4.6.6`. There is no patched `zod` 3.x release; the
  last 3.x version is `3.25.76`.
- **This project's own `zod`:** `4.6.7` (`package.json`). It validates every request body and MCP
  tool input, including the batch arrays (`business_numbers`, `hs_codes`, at most 100 entries):
  `src/rest.ts`, `src/mcp.ts`, and the MCP SDK, which resolves the same `zod` 4.6.7.
- **`zod` 3.25.76 is still installed**, because these dependencies require `zod` 3:
  `@x402/core@2.28.0` (`^3.24.2`), `@x402/evm@2.28.0`, `@x402/extensions@2.28.0`,
  `@coinbase/x402@2.1.0` (`^3.24.2`) and its dependency `@coinbase/cdp-sdk@1.55.0` (`^3.25.76`).
  The latest published releases (`@x402/*` 2.28.0, `@coinbase/x402` 2.1.0, `@coinbase/cdp-sdk`
  1.60.0) still require `zod` 3, so the audit entries cannot be cleared within their supported
  ranges. `npm audit` lists the x402 and Coinbase packages themselves (and
  `abitype`) as affected because of this transitive `zod`.
- **Where `zod` 3 runs when this server handles a request** (found by searching each package's
  published `dist/` for `zod` imports and schema calls):
  - `@x402/core`, HTTP facilitator client: validates the **facilitator's responses** to `/verify`,
    `/settle` and `/supported` (`verifyResponseSchema`, `settleResponseSchema`,
    `supportedResponseSchema`; the last contains arrays). This input comes from the configured
    payment facilitator over HTTPS, not from API callers.
  - The `PAYMENT-SIGNATURE` header sent by callers is decoded with `JSON.parse` in the server path;
    `@x402/core`'s payload schema helpers (`parsePaymentPayload` and similar) are not called by
    its server code or by `@x402/express`.
  - `@x402/extensions`: `zod` is used only by the Sign-In-With-X extension
    (`SIWxPayloadSchema`), which this server does not register.
  - `@x402/evm`, `@coinbase/x402` and `@coinbase/cdp-sdk` declare the dependency; their published
    builds were searched and contain no `zod` import.
- **Regression test:** `test/batch-100.test.ts`. On all four batch surfaces
  (`check_korean_business_batch`, `check_korea_import_requirements_batch`,
  `POST /v1/business/batch`, `POST /v1/korea-import/requirements/batch`) a 100-entry input is
  accepted and answered, and a 101-entry input is refused with no upstream call. Passing as of
  commit `50ae756` (294 tests in total).
- **Next step:** re-evaluate when `@x402/*` or `@coinbase/x402` move to `zod` 4.6.6 or later.

### Other entries in the same audit

- `body-parser` 2.3.0 (via `express` 5.2.1): GHSA-27r3-jxmh-p828, affected `>=2.0.0 <2.4.0`.
- `follow-redirects` 1.16.0 (transitive): GHSA-q3jh-wrc6-jgq8 and GHSA-8r9p-f939-6h3c, affected
  `>=1.16.0 <1.16.1`.

`npm audit` reports fixes available for both within the current version ranges; they have not
been applied yet as of the date above.

## Reporting a vulnerability

Open an issue at https://github.com/Wonderfulian/kbv-server/issues. Please leave exploit details
out of the public issue; say that you have them, and a private channel will be arranged.
