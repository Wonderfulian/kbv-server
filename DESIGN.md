# DESIGN.md — Korea Business Verify (KBV) MCP Server

> 이 문서는 Claude Code에게 전달하는 작업지시서입니다.
> 구현 전 이 문서 전체를 읽고, Phase 1 범위만 먼저 구현합니다.

---

## 1. 제품 개요

**제품명**: Korea Business Verify (KBV)
**한 줄 정의**: 해외 AI 에이전트가 한국 사업자를 검증할 수 있는 유료 MCP 서버.
사업자등록번호 하나로 진위확인 + 휴폐업 상태 + 정규화된 영문 응답을 한 호출에 제공한다.

**타깃 고객**: 한국 업체와 거래(조달, 계약, 결제, KYB)를 수행하는 해외 자율 에이전트 및 에이전트 개발자.

**차별점 (무료 오픈소스 MCP 대비)**:
1. 제로 셋업 — 원격 URL 하나로 즉시 사용, 계정/API키/설치 불필요
2. 복합 응답 — 상태조회 + 진위확인을 하나의 툴로, 깨끗한 영문 JSON 스키마
3. 운영 보장 — 상시 가동, 원천 API 장애 시 캐시 응답, 응답에 조회 타임스탬프 포함
4. (Phase 2) x402 호출당 결제 — 에이전트가 사람 개입 없이 자동 결제

---

## 2. Phase 구분

| Phase | 범위 | 완료 기준 |
|---|---|---|
| **1. 코어** | MCP 서버 + 국세청 API 연동 + Cloud Run 배포 (무료, 결제 없음) | Claude에서 커넥터로 연결해 실제 사업자번호 조회 성공 |
| **1.5. 공개** | REST 엔드포인트, /llms.txt, 랜딩 문서, 디렉토리 등록 | MCP 디렉토리 3곳 이상 등록 완료 |
| **2. 결제** | x402 미들웨어 + 무료 티어 쿼터 + Bazaar 등록 | 테스트넷에서 유료 호출 1건 성공 → 메인넷 전환 |
| **3. 확장** | 2호 이후 데이터(실거래가, 주소/좌표, 교통 등) 동일 서버에 툴 추가 | 툴 10개 이상 |

**Phase 1이 끝나면 멈추고 사용자(영조님) 컨펌을 받는다. Phase를 건너뛰지 않는다.**

---

## 3. 기술 스택

- **런타임**: Node.js 20 LTS + TypeScript
- **MCP**: 공식 `@modelcontextprotocol/sdk`, **Streamable HTTP transport** (원격 서버이므로 stdio 아님)
- **HTTP 프레임워크**: Express (x402 미들웨어 생태계가 Express 계열에서 가장 성숙)
- **배포**: GCP **Cloud Run** (Dockerfile 기반, GitHub 저장소 연결 자동배포)
- **캐시**: 인메모리 LRU (외부 DB 없음 — 파일럿 단계에서 고정비 0 유지)
- **테스트**: vitest, 원천 API는 mock

## 4. 아키텍처

```
[AI Agent / Claude / GPT ...]
        │  (MCP Streamable HTTP  또는  REST)
        ▼
[Cloud Run: KBV Server (Express + MCP SDK)]
   ├─ rate limiter (무료 티어 쿼터)
   ├─ (Phase 2) x402 payment middleware
   ├─ cache (LRU, TTL 24h)
   ▼
[국세청 사업자등록정보 진위확인 및 상태조회 API (data.go.kr)]
```

- MCP 엔드포인트: `POST /mcp` (Streamable HTTP)
- REST 엔드포인트(Phase 1.5): `GET /v1/business/{brno}/status`, `POST /v1/business/verify`
  - REST를 함께 두는 이유: x402 Bazaar와 일반 HTTP 에이전트 트래픽은 REST 기반 발견이 많음
- 헬스체크: `GET /healthz`

## 5. 원천 API 스펙 (국세청)

- 베이스: `https://api.odcloud.kr/api/nts-businessman/v1`
- 인증: 쿼리스트링 `serviceKey` (환경변수 `NTS_SERVICE_KEY`, **Decoding 키 사용**)
- 엔드포인트:
  - `POST /status?serviceKey=...` — 상태조회. body: `{"b_no": ["1234567890"]}`
  - `POST /validate?serviceKey=...` — 진위확인. body: `{"businesses": [{"b_no": "...", "start_dt": "YYYYMMDD", "p_nm": "대표자명", ...}]}`
- 주요 응답 필드: `b_stt_cd`(01 계속/02 휴업/03 폐업), `tax_type`, `end_dt`(폐업일), `valid`(01 일치/02 불일치)
- 제약: 일일 트래픽 쿼터 있음(개발계정 기본 10,000/일). 429/쿼터 초과 시 캐시로 폴백.
- **주의**: 구현 시작 시 data.go.kr의 최신 공식 문서를 다시 확인할 것 (필드명 변경 가능성).

## 6. MCP 툴 스펙 (Phase 1: 2개만)

### 6.1 `check_korean_business_status`
- 설명(에이전트에게 보이는 문구, 영문):
  "Check the registration status of a Korean business by its 10-digit business registration number (사업자등록번호). Returns whether the business is active, suspended, or closed, plus tax type. Data source: Korea National Tax Service, real-time."
- 입력: `{ business_number: string }`  — 하이픈 포함/미포함 모두 허용, 내부에서 숫자 10자리로 정규화. 10자리가 아니면 명확한 에러 반환.
- 출력(JSON):
```json
{
  "business_number": "1234567890",
  "status": "active" | "suspended" | "closed" | "not_registered",
  "status_code_raw": "01",
  "tax_type": "general" | "simplified" | "exempt" | "non_profit" | "unknown",
  "closed_date": "2023-01-31" | null,
  "checked_at": "2026-08-22T09:00:00Z",
  "source": "Korea National Tax Service (NTS)",
  "cache": false
}
```

### 6.2 `verify_korean_business`
- 설명(영문): "Verify that a Korean business registration number matches the provided representative name and opening date. Use for KYB / due-diligence before transacting with a Korean company. Returns match result plus current status."
- 입력: `{ business_number: string, representative_name: string, opening_date: "YYYY-MM-DD" }`
- 처리: `/validate` 호출 + `/status` 결과를 병합해 한 번에 반환
- 출력: 위 status 스키마 + `"identity_match": true | false`

**공통 규칙**:
- 모든 응답은 영문 필드명, ISO 8601 날짜, UTF-8
- 원천 API 실패 시: 캐시 히트면 `"cache": true`로 반환, 캐시 미스면 `upstream_unavailable` 에러(HTTP 503 상당)를 명확한 메시지로
- 캐시 TTL 24시간, 키는 정규화된 사업자번호(+검증 파라미터 해시)
- 로깅: 요청 수/캐시 히트/원천 지연시간만. **사업자번호 등 조회 내용은 로그에 남기지 않는다(개인정보 최소화)**

## 7. 무료 티어 & 가격 (Phase 2에서 활성화)

- 무료: IP당 10 호출/일 (트래픽 검증 목적)
- 유료: `check_..._status` **$0.02/호출**, `verify_korean_business` **$0.05/호출** (USDC, Base 메인넷)
- 구현: `x402-express` 미들웨어(또는 구현 시점의 최신 x402 MCP 통합 라이브러리). 수취 주소는 환경변수 `X402_PAY_TO_ADDRESS`
- 가격 근거: x402 호출 중간값 $0.028 부근. 추후 데이터 보고 조정.

## 8. 배포 (GCP Cloud Run)

- Dockerfile: node:20-slim, 멀티스테이지 빌드, `PORT` 환경변수 준수(Cloud Run 규약)
- 리전: `asia-northeast3` (서울)
- 환경변수: `NTS_SERVICE_KEY`(Secret Manager), `X402_PAY_TO_ADDRESS`(Phase 2)
- 스케일: min 0 / max 2 인스턴스 (비용 통제)
- CI: GitHub main 브랜치 push → Cloud Run 자동배포

## 9. 저장소 구조

```
kbv-server/
├── src/
│   ├── index.ts            # Express 부팅, MCP transport 마운트
│   ├── mcp.ts              # MCP 서버·툴 정의
│   ├── nts.ts              # 국세청 API 클라이언트 (+재시도 1회)
│   ├── cache.ts            # LRU 캐시
│   ├── normalize.ts        # 사업자번호/날짜 정규화, 상태코드 매핑
│   └── rest.ts             # (Phase 1.5) REST 라우트
├── test/
├── Dockerfile
├── DESIGN.md               # 이 문서
└── README.md               # 영문, 에이전트/개발자 대상 (AEO 원칙 적용)
```

## 10. 완료 체크리스트 (Phase 1)

- [x] `npm test` 통과 (정규화, 상태 매핑, 캐시, mock API) — 62개 테스트, 2026-08-22
- [x] 로컬에서 두 툴 호출 성공 (MCP SDK 클라이언트로 Streamable HTTP 검증, 2026-08-22)
- [x] Cloud Run 배포 후 실제 사업자번호로 조회 성공 (서울 리전, 2026-08-24)
- [ ] Claude.ai 커스텀 커넥터로 등록해 대화에서 조회 성공 ← 유일하게 남음 (진행 방법: PROGRESS.md)
- [x] 에러 케이스 확인: 잘못된 번호, 미등록 번호, 원천 API 다운(mock) — 2026-08-22~24

## 11. 하지 말 것

- Phase 1에서 결제/DB/회원 기능 넣지 않기
- 원천 API 응답을 그대로 통과시키지 않기 (반드시 영문 정규화 스키마로 변환)
- serviceKey를 코드/저장소에 하드코딩하지 않기
- 조회 내용(사업자번호, 대표자명)을 로그·외부 서비스로 보내지 않기
