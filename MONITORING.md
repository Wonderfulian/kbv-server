# KBV 트래픽 모니터링

> 목적: 홍보·기능 추가 전후로 **실사용(tool_call)** 이 늘었는지 같은 잣대로 재는 것.
> 기준선은 2026-08-26 별도 세션에서 실측한 값 ([PHASE2-PLAN-v2.md](PHASE2-PLAN-v2.md) §0 원본).

## 기준선 (2026-08-26)

| 지표 | 값 | 해석 |
|---|---|---|
| /mcp HTTP 요청 | 약 1,250건/일 | **수요 아님** — 대부분 디렉토리 생존확인 봇 (UA에 "never invokes tools" 명시) |
| 실제 tool_call | 24시간 0건 / 7일 9건 | 9건도 등록 직후 자체·심사 테스트로 추정 |

**교훈: 요청 수(request count)로 수요를 판단하지 말 것.** 봇이 섞인 요청 수가 아니라
서버 로그의 `tool_call` 이벤트(실제 툴 실행)만 실사용으로 센다.

## 측정 방법

서버는 조회 내용 없이 이벤트만 로그에 남긴다 — `tool_call`(툴 이름·결과·소요ms), `nts_call`(원천 API 지연).
사업자번호·대표자명은 애초에 로그에 없으므로 아래 명령은 개인정보를 노출하지 않는다.

### 실사용(tool_call) 집계 — 핵심 지표

**PowerShell에서 실행할 것** (Git Bash는 필터 따옴표 처리에 실패함):

```powershell
# 최근 7일 tool_call 이벤트 전부 (한 줄 = 실제 툴 실행 1건)
gcloud logging read "resource.labels.service_name=kbv-server AND jsonPayload.event=`"tool_call`"" --project=kbv-server --freshness=7d --format="value(jsonPayload.tool,jsonPayload.outcome)"

# 건수만 세기
(gcloud logging read "resource.labels.service_name=kbv-server AND jsonPayload.event=`"tool_call`"" --project=kbv-server --freshness=7d --format="value(jsonPayload.tool)" | Measure-Object -Line).Lines
```

### 요청 수·지연·인스턴스 (참고 지표, 봇 포함)

- 콘솔: https://console.cloud.google.com/run/detail/asia-northeast3/kbv-server/metrics?project=kbv-server
- 보는 항목: Request count(봇 포함 총량), Request latency(p50/p99), Container instance count(비용 감시 — max 2 유지 확인), Billable container instance time(과금 시간)

### 국세청 쿼터 감시

- `nts_call` 이벤트 수 ≈ 국세청 API 소모량 (개발계정 한도 10,000건/일)
- 429가 뜨면 로그에 `"ok":false` + 서버는 캐시 폴백으로 동작함

```powershell
gcloud logging read "resource.labels.service_name=kbv-server AND jsonPayload.event=`"nts_call`"" --project=kbv-server --freshness=1d --format="value(jsonPayload.endpoint,jsonPayload.ms,jsonPayload.ok)"
```

## 재측정 기록 (단계 6에서 추가)

| 날짜 | 측정 구간 | tool_call | 비고 |
|---|---|---|---|
| 2026-08-26 | 기준선 | 7일 9건 (24h 0건) | 홍보 전, 등재 3곳 직후 |
| (홍보 1주 후) | | | 성공 기준: 1주 20건 이상 |
