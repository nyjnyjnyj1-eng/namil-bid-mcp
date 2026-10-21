// 실행기 설정. 비밀값(키·암호)은 Cloudflare 대시보드의 Secret으로만 넣습니다.
export interface Env {
  // 비밀값 (Secret)
  NOTION_TOKEN?: string;
  CORAL_API_KEY?: string;
  HIVE_API_KEY?: string;
  WEB_PASSCODE?: string;

  // 일반 설정 (wrangler.toml [vars])
  NOTION_REQUESTS_DS_ID: string;
  NOTION_RECORDS_DS_ID: string;
  CORAL_BASE_URL: string;
  CORAL_MODEL: string;
  HIVE_BASE_URL: string;
  HIVE_MODEL: string;
  // Hive 검사용 주소와 요청 본문 틀. 본문 틀의 {{TEXT}} 자리에 검사할 글이 들어갑니다.
  HIVE_CHECK_URL?: string;
  HIVE_CHECK_BODY?: string;
}

export const LIMITS = {
  // Cloudflare 무료 플랜: 실행 1회당 외부 호출 50회. 여유를 두고 45회에서 멈춥니다.
  subrequests: 45,
  // 결과 저장에 필요한 호출 수만큼 남겨 둡니다.
  writeReserve: 10,
  defaultRounds: 3,
  maxRounds: 5,
  maxRefs: 4,
  perPageChars: 15000,
  totalMaterialChars: 60000,
  // 실행 중 표시가 이 시간보다 오래되면 멈춘 작업으로 보고 다시 가져갑니다.
  leaseMinutes: 20,
} as const;
