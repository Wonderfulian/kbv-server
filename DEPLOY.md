# KBV 서버 Cloud Run 배포 가이드 (초보자용)

> 이 문서는 로컬에서 완성·검증된 KBV 서버를 Google Cloud Run(서울 리전)에 올리는 절차입니다.
> 소요 시간: 처음이면 30~40분. 비용: min-instances 0 설정이라 트래픽이 없으면 **0원에 가깝습니다**.

## 준비물

1. **Google 계정 + GCP 프로젝트**: https://console.cloud.google.com 에서 새 프로젝트 생성 (예: `kbv-server`). 결제 계정 연결이 필요합니다(무료 크레딧으로 충분).
2. **gcloud CLI 설치**: https://cloud.google.com/sdk/docs/install 에서 Windows 설치 파일을 받아 설치. 설치 후 PowerShell을 **새로 열어** `gcloud --version`이 찍히는지 확인.

## 1. 로그인과 프로젝트 설정

```powershell
gcloud auth login                      # 브라우저가 열리면 Google 계정으로 로그인
gcloud config set project 프로젝트ID    # 예: gcloud config set project kbv-server-123456
```

프로젝트ID는 GCP 콘솔 상단에서 확인할 수 있습니다 (이름이 아니라 ID입니다).

## 2. 필요한 서비스 켜기 (프로젝트당 1회)

```powershell
gcloud services enable run.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

무엇을 켜는 건가요? — Cloud Run(서버 실행), Secret Manager(API 키 금고), Cloud Build(도커 이미지 자동 빌드), Artifact Registry(이미지 보관소).

## 3. 국세청 키를 Secret Manager에 등록

키를 명령어에 직접 타이핑하면 터미널 기록에 남으므로, **임시 파일로 올리고 바로 삭제**합니다.

```powershell
# .env 파일 안의 NTS_SERVICE_KEY= 뒤의 값(디코딩 키)을 복사해서 아래 따옴표 안에 붙여넣기
[IO.File]::WriteAllText("$PWD\nts-key.txt", "여기에_디코딩_키_붙여넣기")
gcloud secrets create nts-service-key --replication-policy=automatic --data-file=nts-key.txt
Remove-Item nts-key.txt
```

(`nts-key.txt`는 .gitignore에 이미 등록돼 있어 실수로 커밋될 수 없습니다.)

이제 Cloud Run이 이 금고를 열 수 있게 권한을 줍니다:

```powershell
# 먼저 프로젝트 번호(숫자)를 확인
gcloud projects describe 프로젝트ID --format="value(projectNumber)"

# 위에서 나온 숫자로 아래 PROJECT_NUMBER 부분을 바꿔 실행
gcloud secrets add-iam-policy-binding nts-service-key --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" --role="roles/secretmanager.secretAccessor"
```

## 4. 배포 (이 폴더에서 실행)

```powershell
gcloud run deploy kbv-server --source . --region asia-northeast3 --allow-unauthenticated --min-instances 0 --max-instances 2 --memory 512Mi --set-secrets "NTS_SERVICE_KEY=nts-service-key:latest"
```

- `--source .` : 이 폴더의 Dockerfile로 Cloud Build가 알아서 이미지를 만들어 배포
- `--region asia-northeast3` : 서울 리전
- `--allow-unauthenticated` : 누구나 접속 가능한 공개 URL 발급 (MCP 서버이므로 필요)
- `--min-instances 0 --max-instances 2` : 트래픽 없으면 0대(비용 0), 최대 2대(비용 통제)

처음 배포는 이미지 빌드 때문에 몇 분 걸립니다. 끝나면 `https://kbv-server-xxxx.a.run.app` 형태의 **Service URL**이 출력됩니다.

## 5. 배포 확인

```powershell
# 1) 헬스체크 — {"ok":true}가 나오면 성공
Invoke-RestMethod https://서비스URL/health

# 2) MCP Inspector로 실제 툴 호출
npx @modelcontextprotocol/inspector
# → Transport: Streamable HTTP, URL: https://서비스URL/mcp → Connect → List Tools
```

## 6. Claude.ai 커스텀 커넥터 등록 (Phase 1 완료 기준)

1. https://claude.ai → 설정(Settings) → **Connectors** → **Add custom connector**
2. URL에 `https://서비스URL/mcp` 입력 → 저장
3. 새 대화에서 커넥터를 켜고 물어보기: *"사업자번호 124-81-00998 상태 확인해줘"*
4. Claude가 `check_korean_business_status` 툴을 호출해 결과를 보여주면 **Phase 1 완료** 🎉

## 7. (선택) GitHub 연결 자동 배포

이후 `git push`만 하면 자동 배포되게 하려면: GCP 콘솔 → Cloud Run → kbv-server 서비스 → **"Set up continuous deployment"** 버튼 → GitHub 저장소 연결 → main 브랜치 선택. (GitHub에 저장소를 먼저 만들어 push해 두어야 합니다.)

## 문제 해결

| 증상 | 원인/해결 |
|---|---|
| 배포 중 권한 오류 | 2번의 `gcloud services enable`을 건너뛰었거나 결제 계정 미연결 |
| 서버는 떴는데 툴 호출 시 upstream_unavailable | Secret 등록/권한(3번) 문제 — 키가 **디코딩 키**인지도 확인 |
| 429 quota 오류 | 국세청 일일 쿼터(개발계정 10,000건) 소진 — 다음날 자동 리셋 |
| 특정 경로만 구글 404 (서비스는 정상) | run.app 주소에서 `z`로 끝나는 경로(`/healthz` 등)는 구글 관문이 가로챕니다 — `/health`처럼 z로 끝나지 않는 경로를 쓰세요. 진짜 라우팅 문제인지는 `/` 요청이 Express의 "Cannot GET /"을 주는지로 구분 |
