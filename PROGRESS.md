# KBV 프로젝트 진행 기록

> 마지막 업데이트: 2026-08-24
> 이 문서는 세션별 작업 내용과 다음 할 일을 기록합니다. (설계 사양은 [DESIGN.md](DESIGN.md) 참고)

## 현재 상태 (한 줄 요약)

**✅ Phase 1 완료 (2026-08-24).** Cloud Run 배포 + Claude/ChatGPT 양쪽 커넥터에서 접속·조회 성공.
Claude 커넥터 경유 전 구간(Claude → Cloud Run → 국세청) 실호출 검증까지 마침. 다음은 Phase 1.5 (공개 준비).

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

## 다음에 할 일

### 1. Phase 1.5 — 공개 준비 (진행 중)
- [x] README.md 외부 공개용 개편 (영문, AEO 구조화, 연결 방법·라이선스·개인정보·가격 안내) — 2026-08-24
- [ ] REST 엔드포인트: `GET /v1/business/{brno}/status`, `POST /v1/business/verify`
- [ ] `/llms.txt`, 랜딩 문서(AEO 원칙)
- [ ] MCP 디렉토리 3곳 이상 등록

### 2. 선택 작업 (급하지 않음)
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
