import type { Board, JobRunner } from "./runner";

// 실행기 설정. 비밀값(키·암호)은 Cloudflare 대시보드의 Secret으로만 넣습니다.
export interface Env {
  // 비밀값 (Secret). 없어도 무료 모델로 동작합니다.
  NOTION_TOKEN?: string;
  CORAL_API_KEY?: string;
  HIVE_API_KEY?: string;
  WEB_PASSCODE?: string;

  // 일반 설정 (wrangler.toml [vars])
  NOTION_REQUESTS_DS_ID: string;
  NOTION_RECORDS_DS_ID: string;
  NOTION_HOME_URL?: string;
  CORAL_BASE_URL: string;
  CORAL_MODEL: string;
  HIVE_BASE_URL: string;
  HIVE_MODEL: string;
  FREE_MODEL: string;
  // 자동 모드에서 시도하는 순서 (예: "coral,hive,free")
  AUTO_ORDER?: string;
  // Hive 검사용 주소와 요청 본문 틀. 본문 틀의 "{{TEXT}}" 자리에 검사할 글이 들어갑니다.
  HIVE_CHECK_URL?: string;
  HIVE_CHECK_BODY?: string;

  // Cloudflare 연결
  AI: Ai;
  RUNNER: DurableObjectNamespace<JobRunner>;
  BOARD: DurableObjectNamespace<Board>;
}

export const LIMITS = {
  // Cloudflare 무료 플랜: 실행 1회당 외부 호출 50회. 작업을 단계로 나눠 단계마다 45회 안에서 처리합니다.
  subrequests: 45,
  defaultRounds: 3,
  maxRounds: 5,
  maxRefs: 4,
  perPageChars: 15000,
  totalMaterialChars: 60000,
  maxInstructionChars: 20000,
  // 실행 중인데 이 시간 넘게 진행이 없으면 다시 이어서 실행합니다.
  stallMs: 20 * 60_000,
  // 일시적인 오류(혼잡·서버 오류·네트워크)는 이 간격으로 3번까지 다시 시도합니다.
  retryDelaysMs: [5_000, 20_000, 60_000],
  // 자동 모드: 막힌 것으로 확인된 모델은 이 시간 동안 건너뜁니다.
  healthTtlMs: 30 * 60_000,
  modelTimeoutMs: 240_000,
  maxTokens: 4096,
  recentKeep: 60,
  // 끝난 작업의 실행 정보는 30일 뒤 지웁니다(노션에 저장한 결과는 그대로 남습니다).
  cleanupMs: 30 * 24 * 3600_000,
} as const;
