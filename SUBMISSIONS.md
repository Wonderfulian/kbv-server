# KBV 디렉토리 제출 키트

> 마지막 업데이트: 2026-09-04 (가격 문구: "free during pilot" → "10 free calls/day, then pay-per-call (x402)")
> MCP 디렉토리 등록에 쓰는 공통 자료 모음입니다. 영문 카피는 아래 블록을 그대로 복사해 쓰세요.

## 공통 제출 자료 (영문)

**Name**: `Korea Business Verify (KBV)`

**One-liner** (공식 레지스트리 100자 제한 대응):

```
Real-time Korean business verification via NTS. 10 free calls/day, then pay-per-call (x402).
```

**Short blurb** (~160자):

```
Verify any Korean company by its 10-digit business registration number: active/closed status, tax type, and KYB identity match. Live NTS data, no API key, one URL.
```

**Long description**:

```
Korea Business Verify (KBV) is a hosted MCP server — 10 free calls/day, then pay-per-call via x402 — that verifies Korean businesses in real time. Give it a 10-digit Korean business registration number (사업자등록번호) and it returns the registration status (active / suspended / closed), tax type, and — optionally — whether the number matches a representative name and opening date (KYB identity check). Data comes live from the Korea National Tax Service (NTS) official open-data API and is returned as clean, English-normalized JSON. No account, no API key, no installation — connect any MCP-capable agent to one URL.

Tools:
- check_korean_business_status — registration status + tax type by business number
- check_korean_business_batch — up to 100 numbers in one call, order preserved, with summary
- verify_korean_business — KYB identity match (number + representative name + opening date, optional address) plus current status

Example prompts:
- "Check the status of Korean business 124-81-00998."
- "Verify that Korean business 214-87-12345 belongs to 홍길동, opened 2015-03-02."

Privacy: query contents (business numbers, names) are never logged. Data license: Korean government open data, no usage restrictions. Pricing: 10 free calls/day per IP; beyond that, pay-per-call via x402 ($0.02–$0.05, USDC on Base).
```

**Tags / categories**:

```
business, verification, kyb, finance, government, korea, api, due-diligence
```

**URLs**:

- MCP endpoint: `https://kbv-server-f7vfitmlkq-du.a.run.app/mcp` (Streamable HTTP, no auth)
- Health: `https://kbv-server-f7vfitmlkq-du.a.run.app/health`
- Repo: `https://github.com/Wonderfulian/kbv-server`

---

## 디렉토리별 진행 현황과 방법

### 1. 공식 MCP Registry — 🤖 자동 (완료되면 PulseMCP도 자동 커버)

- 방법: 저장소의 [server.json](server.json) + GitHub Actions([publish-mcp-registry.yml](.github/workflows/publish-mcp-registry.yml))가 `v*` 태그 push 시 자동 게시
- 새 버전 게시: server.json의 version 올리고 `git tag v0.2.0 && git push origin v0.2.0`
- 등재 확인: https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.Wonderfulian/kbv-server
- [x] **등재 확인됨** (2026-08-24, status: active) — 주의: 네임스페이스는 GitHub 계정명 대소문자까지 일치해야 함(`io.github.Wonderfulian`)

### 2. PulseMCP — 🤖 자동 (별도 행동 불가/불필요)

- 직접 제출 중단 중. 공식 레지스트리 항목을 재개 후 주간 수집한다고 공지 (pulsemcp.com/submit)
- [ ] 등재 확인됨 (수집 재개 후 확인)

### 3. Glama — 🧑 사람 ~5분

1. https://glama.ai 로그인 (GitHub 계정 권장 — Wonderfulian)
2. MCP Servers 페이지 → **Add MCP Server** → 저장소 URL `https://github.com/Wonderfulian/kbv-server` 제출, 이름·설명은 위 Name/Short blurb 붙여넣기
3. (선택) Connectors 페이지 → **Add MCP Server → Connector** → 호스팅 URL `https://kbv-server-f7vfitmlkq-du.a.run.app/mcp` 도 등록
4. 심사는 자동(수 분). 저장소의 [glama.json](glama.json)이 소유권 표시 역할
- [x] 제출함 (2026-08-25)  - [x] **등재 확인됨** (2026-08-25, 등재 페이지에서 실호출 검증까지 완료)

### 4. Smithery — 🧑 사람 ~10분 (웹 UI로 직접, API 키를 채팅에 붙일 필요 없음)

1. https://smithery.ai 가입 (GitHub 로그인 — Wonderfulian)
2. https://smithery.ai/new 접속 → **URL 방식** 선택 → MCP URL `https://kbv-server-f7vfitmlkq-du.a.run.app/mcp` 붙여넣기
3. 네임스페이스/이름: `@wonderfulian/kbv-server` → 게시. Smithery가 서버를 자동 스캔해 툴 목록을 채웁니다(무인증 공개 서버라 통과 예상)
4. 대시보드에서 설명(위 Short blurb)·아이콘 다듬기
- [x] **게시됨** (2026-08-25, `@wonderfulian` 네임스페이스 — 자동 스캔이 툴 2개 정상 인식)

### 5. mcp.so — 🧑 사람 ~5분 (웹 폼은 유료 전환 → GitHub 이슈로 무료 제출)

- 배경(2026-08-25): mcp.so/submit 웹 폼은 유료 옵션만 노출됨 → 디렉토리 저장소 [chatmcp/mcpso](https://github.com/chatmcp/mcpso)에 **이슈로 제출하는 관례**를 사용 (최근 제출 이슈 다수 확인, 제목 `[Submit] ...` 형식)
1. 로그인된 브라우저로 https://github.com/chatmcp/mcpso/issues/new 열기 (에이전트가 만든 원클릭 링크가 있으면 그걸 열면 제목·본문이 미리 채워짐)
2. 아래 제목·본문 붙여넣기 → 내용 확인 → **Submit new issue**

제목:

```
[Submit] Korea Business Verify (KBV) - real-time Korean business verification via the National Tax Service (no-auth remote)
```

본문:

````markdown
## MCP Server Submission: Korea Business Verify (KBV)

**Name:** Korea Business Verify (KBV)
**Official registry name:** `io.github.Wonderfulian/kbv-server` (status `active`)
**Remote MCP (Streamable HTTP, no auth):** https://kbv-server-f7vfitmlkq-du.a.run.app/mcp
**GitHub:** https://github.com/Wonderfulian/kbv-server
**Health check:** https://kbv-server-f7vfitmlkq-du.a.run.app/health
**Transport:** Streamable HTTP
**Authentication:** none — public, no API key required

**Description:** Verify any Korean company by its 10-digit business registration number (사업자등록번호): active/closed status, tax type, and KYB identity match. Data comes live from the Korea National Tax Service (NTS) official open-data API and is returned as clean, English-normalized JSON. No account, no API key, no installation — 10 free calls/day, then pay-per-call via x402.

### Tools

- `check_korean_business_status` — registration status (active / suspended / closed / not_registered) + tax type by business number
- `check_korean_business_batch` — up to 100 numbers in one call, order preserved, with summary
- `verify_korean_business` — KYB identity match (number + representative name + opening date, optional address) plus current status

### Example prompts

- "Check the status of Korean business 124-81-00998."
- "Verify that Korean business 214-87-12345 belongs to 홍길동, opened 2015-03-02."

### Client config

```json
{
  "mcpServers": {
    "korea-business-verify": {
      "type": "http",
      "url": "https://kbv-server-f7vfitmlkq-du.a.run.app/mcp"
    }
  }
}
```

### Verify before indexing

```bash
curl -s -X POST https://kbv-server-f7vfitmlkq-du.a.run.app/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Privacy: query contents (business numbers, names) are never logged. Data license: Korean government open data, no usage restrictions. Pricing: 10 free calls/day per IP; beyond that, pay-per-call via x402 ($0.02–$0.05, USDC on Base).

Please list on https://mcp.so as a remote Streamable HTTP server.
````

- [x] **이슈 제출됨** ([chatmcp/mcpso#3741](https://github.com/chatmcp/mcpso/issues/3741), 2026-08-25)  - [ ] 등재 확인됨 (메인테이너 처리 대기)

### 6. awesome-mcp-korea — 🧑 사람 ~5분 (GitHub 웹 에디터가 포크+PR 자동 생성)

1. 로그인된 브라우저로 https://github.com/darjeeling/awesome-mcp-korea/edit/main/README.md 열기 → "Fork this repository" 안내가 나오면 수락 (자동 포크)
2. `## 📊 Public Data` 섹션을 찾아 아래 한 줄을 목록에 추가:
   ```
   **[Wonderfulian/kbv-server](https://github.com/Wonderfulian/kbv-server)** – 국세청 API 기반 사업자등록 상태조회·진위확인 원격 MCP 서버. 설치·API키 불필요, URL 하나로 연결. (Korean business verification MCP server via NTS — 10 free calls/day, then x402 pay-per-call)
   ```
3. **Commit changes** → **Create pull request** (제목 예: `Add Korea Business Verify (KBV)`)
- [ ] PR 생성됨  - [ ] 병합됨

## 분담 요약

| 작업 | 담당 |
|---|---|
| 저장소 파일(LICENSE, server.json, glama.json, CI), 제출 카피 전체, 공식 레지스트리 게시 ✅완료 | 🤖 에이전트 |
| Smithery 웹 UI 게시 (~10분, API 키 공유 불필요) | 🧑 영조님 |
| Glama 폼 제출 (~5분) | 🧑 영조님 |
| mcp.so 이슈 제출 (~5분, 웹 폼은 유료라 GitHub 이슈 경로) | 🧑 영조님 |
| awesome-mcp-korea 웹 에디터 PR (~5분) | 🧑 영조님 |
