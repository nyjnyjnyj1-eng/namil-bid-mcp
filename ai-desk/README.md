# AI 작업실 실행기 (ai-desk) v2

맡긴 일을 AI 모델(Coral Bricks · Hive · Cloudflare 무료 모델)로 처리하고, 원하면 결과를 노션 **AI 작업실**에 남기는 Cloudflare Worker입니다.
기존 입찰 서버(`g2b-mcp`)와 `support-watch`와는 완전히 분리되어 있고, 그 Worker들을 건드리지 않습니다.

## 쓰는 법

| 방법 | 어떻게 | 결과 |
|---|---|---|
| **입력창** (가장 쉬움) | <https://ai-desk.nyj8772.workers.dev> → 처음 한 번 암호 → 적고 **보내기** | 화면에 바로. **노션에 저장**을 켜면 작업 기록에도 |
| **노션 요청함** | 행을 만들고 본문에 지시서, 상태를 **대기**로 | 1분 안에 처리, 행 본문 아래 '실행 결과'에 덧붙임 |
| **Claude · ChatGPT** | 설정 화면의 안내문을 지침에 붙여 두고 "AI 작업실에 맡겨" | Claude는 요청함에 행을 만들고, ChatGPT는 지시서를 만들어 줌 |

사용자용 설명은 노션 **AI 작업실 › 사용법**에 있습니다.

## 구조

```
입력창(웹 앱) ── POST /api/jobs ────────┐
노션 요청함(상태=대기) ── 1분마다 확인 ──┼──▶ JobRunner (작업 1건 = Durable Object 1개)
다른 Worker ── 서비스 바인딩 DeskAPI ───┘      단계마다 알람으로 따로 실행 (무료 플랜 한도 안에 들도록)
                                               ├ gather  지시서·참고 페이지 읽기 (표 포함, 최대 4쪽)
                                               ├ think   모델 호출. 자동이면 Coral → Hive → 무료 모델 순서
                                               │         '노션에서 찾기'를 켜면 검색·읽기를 최대 N번 반복
                                               ├ check   Hive 검사 (선택)
                                               └ write   노션에 새 페이지 / 행 아래 덧붙이기 → 다시 읽어 확인
                                             Board (최근 작업 60개, 모델 상태를 30분 기억)
```

- **자동 모드**: 키가 틀렸거나 카드·크레딧이 필요한 모델은 이유를 기록하고 30분 동안 건너뜁니다. 그래서 유료 키가 하나도 없어도 무료 모델로 답합니다.
- **간단 / 정리 모드**: 입력창에서 노션 기능을 끄고 물으면 답만 돌려줍니다(모델 호출 1번). 노션 저장·찾기를 켜거나 요청함에서 맡기면 새 결과·근거·한계·다음 할 일·사용한 자료로 나눠 씁니다.

| 파일 | 하는 일 |
|---|---|
| `src/index.ts` | 주소(화면, `/api/*`, `/health`), 내부 입구 `DeskAPI`, 1분 주기 실행 |
| `src/runner.ts` | `JobRunner` · `Board` (Durable Object) |
| `src/job.ts` | 작업 단계(읽기 → 생각 → 검사 → 저장)와 결과 정리 |
| `src/providers.ts` | Coral · Hive · 무료 모델 호출, 자동 순서, 오류 분류 |
| `src/intake.ts` | 노션 요청함 확인, 멈춘 작업 다시 깨우기 |
| `src/notion.ts`, `src/blocks.ts` | 노션 API, 블록 ↔ 글 변환 |
| `src/protocol.ts` | 모델에게 주는 지시와 응답 읽기 |
| `src/web/page.html` | 웹 앱 (파일 하나, 외부 자원 없음, 홈 화면에 추가 가능) |

## 무료 한도 판단

Cloudflare 무료 플랜 기준([Workers 한도](https://developers.cloudflare.com/workers/platform/limits), [Durable Objects 요금](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Workers AI 요금](https://developers.cloudflare.com/workers-ai/platform/pricing/)):

| 한도 | 무료 플랜 | 이 실행기 |
|---|---|---|
| 실행 1회당 외부 호출 | 50회 | 단계마다 따로 실행하고, 한 단계에서 45회를 넘기면 멈춤 |
| 실행 1회당 CPU 시간 | 10ms (응답 대기 제외) | 단계로 나눠 한 번에 하는 계산을 줄임. 배포 후 로그로 확인 |
| 주기 실행 | 계정당 5개 | 1개 (`support-watch`와 합쳐 2개) |
| Worker 요청 | 하루 100,000회 (계정 전체) | 1분 주기 1,440회 + 화면 사용. 화면은 작업이 끝나면 확인을 멈추고, 오류가 나면 간격을 늘림 |
| Durable Objects 요청 | 하루 100,000회 | 주기 실행마다 1~2회 + 작업 단계마다 1회 + 화면 확인 |
| Durable Objects 시간 | 하루 13,000 GB-s | 작업 중 모델 응답을 기다리는 동안만 |
| Workers AI | 하루 10,000 뉴런, 00:00 UTC(오전 9시) 초기화 | 짧은 시험 호출 1건 14뉴런(실측). 다 쓰면 과금 없이 멈추고 자동이 다른 모델로 넘어감 |

## 설정 (이미 연결됨)

- **배포**: Worker `ai-desk`는 Workers Builds로 이 저장소에 연결되어 있습니다.
  - 브랜치 `claude/sweet-allen-ww9pah`, 폴더 `ai-desk/` 안이 바뀌어 push될 때만 빌드
  - `npm ci && npm run check`(타입 검사·시험)가 통과해야 `npx wrangler deploy`
  - 빌드 결과: Cloudflare 대시보드 → Workers & Pages → `ai-desk` → Deployments
- **비밀값**: `ai-desk` → Settings → Variables and Secrets에 종류 **Secret**으로 넣습니다. 채팅이나 노션에는 적지 않습니다.
  - 꼭 필요: `NOTION_TOKEN`, `WEB_PASSCODE`(입력창 암호, 16자 이상 무작위). 없으면 배포가 멈춥니다.
  - 있으면 씀: `CORAL_API_KEY`, `HIVE_API_KEY`. 없거나 틀리면 자동 모드가 건너뜁니다.
- **노션 연결**: 내부 연결 `AI 작업실 실행기`(콘텐츠 읽기·업데이트·삽입만). **AI 작업실**과, 읽게 할 페이지에만 연결을 추가합니다.
- **점검**: `https://ai-desk.nyj8772.workers.dev/health` → `secrets`가 모두 `true`인지(값은 보이지 않음). 입력창 설정 → **지금 점검하기**로 모델별 상태와 읽을 수 있는 노션 페이지를 봅니다.

## 보안과 데이터

- **외부 전송**: 보낸 글과 실행기가 읽은 노션 내용은 답하는 모델 쪽으로 갑니다(Coral Bricks, Hive, 또는 Cloudflare Workers AI). 비밀값은 각 서비스로만 가고 노션·로그·화면에 남지 않습니다.
- **노션 접근 범위**: 실행기 연결을 추가한 페이지와 그 하위만 읽고 검색할 수 있습니다.
- **기존 자료 보존**: 실행기는 새 페이지 만들기, 블록 아래에 덧붙이기, 요청 행 속성 바꾸기만 합니다. 기존 블록을 고치거나 지우는 호출은 코드에 없고, 시험으로 확인합니다.
- **저장 확인**: 작업 기록 페이지는 다시 읽어 보낸 내용과 비교하고, 행에 덧붙인 결과는 노션이 돌려준 저장 결과와 비교합니다. 다르면 상태가 `저장 확인 실패`가 됩니다.
- **중복 방지**: 단계마다 진행 상황을 저장해 두므로, 다시 시도해도 기록 페이지를 두 번 만들지 않습니다.
- **복구**: 일시적인 오류는 5초·20초·60초 뒤 다시 시도합니다. 20분 넘게 멈춘 작업은 1분 주기 실행이 다시 깨우고, 3번 넘게 멈추면 `실패`로 남깁니다. 실패한 요청은 오류 칸을 확인한 뒤 상태를 `대기`로 바꾸면 다시 실행됩니다. 노션 페이지 기록(버전 기록)으로 되돌릴 수도 있습니다.
- **입력창**: 암호(16자 이상)가 없거나 틀리면 아무것도 하지 않습니다. 암호는 그 기기 브라우저에만 저장되고 요청 머리글로만 보냅니다. 유출이 의심되면 `WEB_PASSCODE`를 바꿉니다.
- **보관 기간**: 입력창 작업은 끝나고 30일 뒤 Cloudflare에서 지워집니다. 오래 남길 것은 노션에 저장합니다.

## 확인하지 못한 것

- **Coral**: 계정에 카드 등록이 필요해(403 `card_required`) 실제 답을 받아 보지 못했습니다. 기본 모델 ID `deepseek-v4.1-flash-fast`는 공개 자료 기준입니다.
- **Hive**: 지금 넣어 둔 키가 거절됩니다(401). 인증 방식(`Authorization: Bearer`)과 기본 모델 `zai-org/glm-5.3-flash`는 Hive 문서 기준입니다.
- **Hive 검사**(AI 생성 글 감지 등)의 V3 요청 형식은 이 환경에서 문서를 열지 못해 확인하지 못했습니다. `HIVE_CHECK_URL`과 `HIVE_CHECK_BODY`(본문 틀의 `"{{TEXT}}"` 자리에 검사할 글이 들어감)를 문서 확인 후 채우도록 비워 두었고, 비어 있으면 화면에서 이 선택지가 숨겨집니다.

## 개발

```bash
cd ai-desk
npm ci
npm run check    # 타입 검사 + 시험 (가짜 노션·Coral·Hive·무료 모델 사용, 실제 호출 없음)
```
