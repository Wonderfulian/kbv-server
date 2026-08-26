# KBV 프로젝트 진행 기록

> 마지막 업데이트: 2026-08-26
> 이 문서는 세션별 작업 내용과 다음 할 일을 기록합니다. (설계 사양은 [DESIGN.md](DESIGN.md) 참고)

## 현재 상태 (한 줄 요약)

**✅ Phase 1.5 완료, Phase 2(수익화) 진입 (2026-08-26).** 작업지시서는 [PHASE2-PLAN-v2.md](PHASE2-PLAN-v2.md)가 기준.
디렉토리 3곳 등재 확정(공식 Registry·Smithery·Glama), REST 2종 구현·검증 완료(배포는 다음 단계와 함께).
**다음 세션 시작점: v2 단계 1 — 일괄검증 툴 `check_korean_business_batch`.**

- **서비스 URL**: https://kbv-server-f7vfitmlkq-du.a.run.app
- **MCP 엔드포인트**: `https://kbv-server-f7vfitmlkq-du.a.run.app/mcp` (POST 전용)
- **헬스체크**: https://kbv-server-f7vfitmlkq-du.a.run.app/health ← 브라우저로 열면 `{"ok":true}`
- **GCP**: 프로젝트 `kbv-server` / 서울 리전(asia-northeast3) / min 0 ~ max 2 인스턴스 (유휴 시 비용 ≈ 0원)

---

## 완료된 작업

### 2026-08-22 — Phase 1 구현 (로컬)

- 프로젝트 초기 세팅: .gitignore(실키가 든 .env 보호) → git init → npm/TypeScript(ESM, strict) 구성
- 소스 5개 파일 구현:
  - [src/normalize.ts](src/normalize.ts) — 사업자번호/날짜 정규화, 상태·과세유형 코드 → 영문 매핑
  - [src/nts.ts](src/nts.ts) — 국세청 API 클라이언트 (배치 최대 100건, 실패 시 1회 재시도, 429는 무재시도, fetch 주입으로 테스트 가능)
  - [src/cache.ts](src/cache.ts) — LRU 캐시 24시간, 원천 장애 시 폴백 (verify 키는 sha256 해시로 개인정보 미노출)
  - [src/mcp.ts](src/mcp.ts) — MCP 툴 2개: `check_korean_business_status`, `verify_korean_business`(선택 입력 address → b_adr)
  - [src/index.ts](src/index.ts) — Express + Streamable HTTP stateless 마운트, /health, PORT 준수
- 테스트 62개 전부 통과 (vitest, 원천 API 전체 mock — 네트워크/쿼터 소모 0)
- 실제 국세청 API 로컬 검증: 삼성전자(124-81-00998) → active / 미등록 → not_registered / 형식오류 → 명확한 에러 / 틀린 대표자명 verify → identity_match false
- Dockerfile(node:22-slim 멀티스테이지), README.md(영문), DEPLOY.md(한국어 배포 가이드) 작성
- 주요 결정: Node 22 LTS(설계서의 Node 20은 EOL), MCP SDK v1(^1.30) + zod 4 + express 5

### 2026-08-24 — Cloud Run 배포 + 장애 해결

- GCP 전용 프로젝트 `kbv-server` 생성, 기존 결제 계정 연결, 서비스 4종 활성화
- 국세청 키를 Secret Manager `nts-service-key`에 등록 (키가 화면/기록에 노출되지 않는 절차 사용)
- 서울 리전 배포 성공 — 그러나 `/healthz` 확인 시 구글 404 발생
- **원인 규명 과정** (약 4시간의 교훈):
  - 처음엔 "신규 프로젝트의 URL 라우팅 미등록(구글 결함)"으로 오진 → 도쿄 리전 실험 배포, 장시간 대기 모두 무효
  - 구글 포럼/이슈트래커에서 진짜 원인 발견: **run.app 주소에서 `z`로 끝나는 경로(`/healthz` 등)는 구글 관문(GFE)이 가로채 자체 404를 반환** — 서버는 처음부터 정상이었고 확인 경로만 잘못 골랐던 것
  - 판별법: `GET /` 요청에 Express의 "Cannot GET /"가 나오면 라우팅은 정상
- 조치: `/healthz` → `/health` 개명(커밋 a2fb0fa) → 재배포(리비전 00002) → `/health` `{"ok":true}` 확인
- 배포 서버로 실조회 최종 검증 성공 (삼성전자 active, 미등록, verify 불일치 모두 정상)
- 진단용 도쿄 중복 서비스 삭제, MCP initialize 핸드셰이크 응답 확인

---

### 2026-08-24 (오후) — Phase 1 완료 확정
- URL 정상화 확인 후 사용자가 **Claude와 ChatGPT 양쪽 커넥터**에서 접속·조회 성공
- Claude 커넥터 경유 전 구간 재검증: /health 200, 삼성전자 → active, 틀린 대표자명 verify → identity_match false
- DESIGN.md Phase 1 체크리스트 5/5 완료

> 참고: `/mcp`를 브라우저로 열면 "Method not allowed"가 나오는데 이는 정상입니다(브라우저는 GET, MCP는 POST). 눈으로 확인하려면 `/health`를 여세요.

### 2026-08-24 (저녁) — GitHub 공개 + MCP 디렉토리 등록

- **GitHub 공개**: 푸시 전 보안 감사(커밋 이력 내 .env·서비스키·개인정보 전수 검색 → 전부 CLEAN) 후 https://github.com/Wonderfulian/kbv-server 공개 (main 브랜치, 영문 설명, 토픽 8개)
- **README 공개용 개편**: 연결 방법(Claude/ChatGPT/Cursor), 실측 I/O 예시, 국세청 출처·이용허락범위 제한 없음, 개인정보 방침, 가격 안내. 카피 원칙: **"free during pilot"** (그냥 "free"로 각인 금지)
- **MIT LICENSE** 추가 (사용자 결정 — 수익원은 코드가 아닌 호스팅)
- **디렉토리 조사** (5곳): PulseMCP는 직접 제출 중단(공식 레지스트리에서 자동 수집), Smithery는 URL 방식 웹 게시, Glama·mcp.so는 웹 폼, awesome-mcp-korea는 PR — 상세는 [SUBMISSIONS.md](SUBMISSIONS.md)
- **공식 MCP Registry 등재 성공** (`io.github.Wonderfulian/kbv-server`, active): server.json + GitHub Actions OIDC 워크플로로 태그 푸시 시 자동 게시. 3번의 시도 끝에 성공 — ①스키마 구버전 ②**네임스페이스 대소문자 불일치**(io.github.wonderfulian ≠ 권한 io.github.Wonderfulian)가 원인이었음
- **보안 원칙 확정**: 자격 증명 관리자 읽기 금지, API 키 채팅 공유 금지 → 인증 필요한 제출은 전부 사용자 웹 UI 절차로 문서화

### 2026-08-25 — 디렉토리 3곳 확정 🎉 + REST 구현 착수

- **디렉토리 제출 결과** (상세는 [SUBMISSIONS.md](SUBMISSIONS.md)):
  - **Smithery 게시 성공** — `@wonderfulian` 네임스페이스, 자동 스캔이 툴 2개 정상 인식
  - **Glama 등재 완료** — 등재 페이지에서 실호출 검증까지 확인
  - **mcp.so**: 웹 폼이 유료 옵션만 노출 → 무료 경로 전환. 디렉토리 저장소 chatmcp/mcpso의 `[Submit]` 이슈 관례를 확인하고, 제목·본문이 미리 채워진 원클릭 링크로 [이슈 #3741](https://github.com/chatmcp/mcpso/issues/3741) 제출 (등재는 메인테이너 처리 대기)
  - → **공식 Registry 포함 등재 확정 3곳** — DESIGN.md Phase 1.5 완료 기준(3곳 이상) 달성
- **REST + llms.txt 구현 초안 작성** (⚠️ typecheck 1차 수정까지만 진행, **테스트 미실행 — 다음 세션 첫 작업**):
  - [src/service.ts](src/service.ts) 신규 — MCP 툴에 갇혀 있던 조회/검증·캐시 폴백 로직을 공용 서비스 계층으로 추출 (`checkStatus`/`verifyBusiness`, 판별 유니온 + `isServiceError` 타입 가드)
  - [src/rest.ts](src/rest.ts) 신규 — `GET /v1/business/:brno/status`, `POST /v1/business/verify` (200/400/503 매핑, MCP와 동일한 `{error, message}` 에러 꼴)
  - [src/landing.ts](src/landing.ts) 신규 — `/` 랜딩 HTML + `/llms.txt` (카피 원칙 "free during pilot" 준수)
  - [src/app.ts](src/app.ts) 신규 — `buildApp(deps)` 팩토리 분리, [src/index.ts](src/index.ts)는 부팅 전용으로 축소, [src/mcp.ts](src/mcp.ts)는 서비스 호출 어댑터로 리팩터
  - [test/rest.test.ts](test/rest.test.ts) 신규 — 실 HTTP(임시 포트) + fake NTS로 REST/랜딩/llms.txt 13케이스
  - 이 코드들은 **워킹 트리에만 있고 커밋 안 됨** (검증 전 커밋 금지 원칙)

### 2026-08-26 — 트래픽 실측 (Phase 2 성공 판정의 기준선)

- **트래픽 기준선**: /mcp HTTP 요청 **1,250건/일** (7일 2,010건)
- **실사용 기준선**: **tool_call 0건/일, 9건/주** — 요청의 대부분은 생존확인 봇 (UA에 "never invokes tools"라고 명시돼 있음). 요청 수는 인기 지표가 아니다
- **판정 기준**: 홍보 후 1주간 **tool_call 20건 이상**. 측정 명령 ↓ (PowerShell에서 실행 — Git Bash는 필터 따옴표 처리 실패)
  ```powershell
  gcloud logging read "resource.labels.service_name=kbv-server AND jsonPayload.event=`"tool_call`"" --project=kbv-server --freshness=7d --format="value(jsonPayload.tool,jsonPayload.outcome)"
  ```

### 2026-08-26 (오후) — 세션 간 꼬임 해소 + REST 검증 완료

- **꼬임의 정체**: Phase 2 계획·정찰·실측이 별도 세션(채팅)에서 먼저 진행되어 [PHASE2-PLAN-v2.md](PHASE2-PLAN-v2.md)가 작성돼 있었는데, 이 터미널 세션은 그걸 모른 채 낡은 "다음 세션 안건"(정찰·모니터링 — 이미 완료된 것)을 기록했음
- **정합화 조치**:
  - [PHASE2-PLAN-v2.md](PHASE2-PLAN-v2.md)를 **기준 작업지시서로 확정** — 아래 할 일 목록을 v2 단계 순서로 교체
  - [MONITORING.md](MONITORING.md) 신설 — 실측 기준선 + tool_call/nts_call 집계 명령 + 재측정 기록표 (구 안건 "모니터링 확인법 정리"를 겸함)
  - v2 §7 범위 제외에 따라 **랜딩·llms.txt 보류**: `src/landing.ts` → `src/landing.ts.shelved`(컴파일·커밋 제외), app.ts 라우트와 관련 테스트 제거
- **REST 검증 완료**: `npm run typecheck` 통과 + 테스트 **74개 전부 통과**(기존 62 + REST 12) → 코드 커밋. v2 §3-1 요구사항("MCP 툴과 동일한 내부 함수 공유")은 service.ts 공용 계층으로 이미 충족
- **배포는 아직 안 함** — 단계 1(batch 툴 + `POST /v1/business/batch`)과 묶어서 한 번에 배포 예정

## 다음에 할 일

### 1. Phase 2 — 수익화 (기준 문서: [PHASE2-PLAN-v2.md](PHASE2-PLAN-v2.md), 단계마다 멈추고 보고)
- [ ] **단계 1 ← 다음 세션 시작점**: 일괄검증 툴 `check_korean_business_batch` (1~100건, 국세청 1회 호출, 번호별 캐시 재사용) + REST `POST /v1/business/batch` + README·server.json 갱신 → 테스트 통과 후 **REST 2종과 함께 첫 배포·라이브 검증**
- [ ] 단계 2: x402 결제 부착 — **구현 전 최신 스펙 조사·보고 필수**(v2 §3-2), 무료 티어 IP당 10회/일, Base Sepolia 전 구간 검증 → 메인넷 실결제 1건
- [ ] 단계 3: x402 Bazaar 등록
- [ ] 단계 4: 빌드 후기 글 배포 (초안은 별도 채팅 세션)
- [ ] 단계 5: awesome-mcp-korea PR ([SUBMISSIONS.md](SUBMISSIONS.md) 6번 절차)
- [ ] 단계 6: 홍보 1주 후 tool_call 재측정 → [MONITORING.md](MONITORING.md) 표에 기록 (성공 기준: 주 20건 이상)

### 2. 수시 확인
- [ ] mcp.so 이슈 [#3741](https://github.com/chatmcp/mcpso/issues/3741) 등재 여부
- [ ] PulseMCP 자동 수집 여부 (공식 레지스트리 경유)

### 완료된 Phase 1.5 (기록용)
- [x] README.md 외부 공개용 개편 (영문, AEO 구조화) — 2026-08-24
- [x] GitHub 공개 저장소 (https://github.com/Wonderfulian/kbv-server, MIT 라이선스) — 2026-08-24
- [x] **공식 MCP Registry 등재** (`io.github.Wonderfulian/kbv-server`, status: active) — 2026-08-24. 태그 푸시로 자동 게시(GitHub Actions OIDC). PulseMCP는 여기서 자동 수집 예정
- [x] **디렉토리 3곳 이상 등재** — 공식 Registry + Smithery + Glama 확정 (2026-08-25). 잔여: mcp.so 이슈 [#3741](https://github.com/chatmcp/mcpso/issues/3741) 등재 확인, awesome-mcp-korea PR
- [x] REST 엔드포인트 2종 (`GET /v1/business/{brno}/status`, `POST /v1/business/verify`) — 2026-08-26 구현·검증 완료, 커밋됨. **배포는 단계 1과 함께**
- ~~`/llms.txt`·랜딩~~ — v2 §7에서 범위 제외로 보류 (코드는 `src/landing.ts.shelved`에 보관)
- 경쟁 서버 정찰·트래픽 실측 — 별도 세션에서 완료 (결과: PHASE2-PLAN-v2.md §0, MONITORING.md)

**등재 과정에서 배운 것**: ① 레지스트리 네임스페이스는 GitHub 계정명 **대소문자까지** 일치 필요 (`io.github.Wonderfulian`) ② server.json의 $schema는 현행 버전(2025-12-11) 사용 ③ PowerShell 5.1에서 커밋 메시지에 큰따옴표 넣으면 인수 깨짐 — 메시지에 따옴표 금지

### 3. 선택 작업 (급하지 않음)
- GitHub 저장소 만들어 push → Cloud Run "Set up continuous deployment" 연결 (push만 하면 자동 배포)
- `gcloud components update` (CLI 구버전 알림 해소)
- 국세청 쿼터 모니터링: 개발계정 10,000건/일 — 트래픽 생기면 운영계정 승급 신청 검토

## 운영 메모

```powershell
# 재배포 (코드 수정 후 이 폴더에서)
gcloud run deploy kbv-server --source . --region asia-northeast3 --quiet

# 서버 로그 보기 (조회 내용은 원래 안 남음 — 건수/지연시간만)
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=kbv-server" --project=kbv-server --limit=20 --format="value(textPayload)" --freshness=1h
```
