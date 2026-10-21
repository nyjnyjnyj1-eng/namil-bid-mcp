// 맡겨진 모델과 주고받는 약속. 모델은 JSON 하나로 "최종 답" 또는 "자료 더 요청"을 보냅니다.
// 모델 자체의 도구 호출 기능에 기대지 않아서 Coral·Hive 어느 모델에서도 같은 방식으로 동작합니다.

export interface FinalAnswer {
  result: string;
  evidence: string[];
  limits: string[];
  nextSteps: string[];
  sources: string[];
}

export type ModelAction =
  | { action: "final"; answer: FinalAnswer }
  | { action: "search"; query: string }
  | { action: "read"; pageId: string }
  | { action: "invalid"; raw: string };

const BASE_RULES = `너는 사용자가 맡긴 작업 지시서를 처리하는 조사·정리 담당이다.
규칙:
1. 지시서와 함께 받은 자료만 근거로 삼는다. 자료에 없는 사실은 지어내지 말고 "확인 안 됨"이라고 쓴다.
2. 판단에는 근거를 붙인다(어느 자료의 어느 내용인지).
3. 지시서의 범위와 금지 사항을 지킨다.
4. 응답은 JSON 객체 하나만 출력한다. 앞뒤에 다른 글을 쓰지 않는다.
최종 답 형식:
{"action":"final","결과":"마크다운으로 쓴 본문","근거":["..."],"한계":["..."],"다음 할 일":["..."],"사용한 자료":["자료 제목"]}`;

export function systemPrompt(selfResearch: boolean, rounds: number): string {
  if (!selfResearch) return BASE_RULES;
  return `${BASE_RULES}

자료가 부족하면 최종 답 대신 아래 중 하나를 출력해 노션에서 자료를 더 받을 수 있다. 쓸 수 있는 횟수는 모두 ${rounds}회다.
{"action":"search","query":"검색어"}  → 노션에서 맞는 페이지 목록(제목과 ID)을 받는다.
{"action":"read","page_id":"페이지 ID"}  → 그 페이지 본문을 받는다.
한 번에 하나만 요청한다. 횟수를 다 쓰거나 충분하면 final을 출력한다.`;
}

function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter((x) => x.trim());
  if (typeof v === "string" && v.trim()) return [v];
  return [];
}

function extractJson(text: string): any {
  const stripped = text.replace(/```(?:json)?/gi, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parseModelOutput(text: string): ModelAction {
  const data = extractJson(text);
  if (!data || typeof data !== "object") return { action: "invalid", raw: text };
  const action = String(data.action ?? "final").toLowerCase();
  if (action === "search" && typeof data.query === "string" && data.query.trim()) {
    return { action: "search", query: data.query.trim().slice(0, 200) };
  }
  if (action === "read" && (data.page_id || data.pageId)) {
    return { action: "read", pageId: String(data.page_id ?? data.pageId) };
  }
  const result = data["결과"] ?? data.result;
  if (typeof result !== "string" || !result.trim()) return { action: "invalid", raw: text };
  return {
    action: "final",
    answer: {
      result,
      evidence: list(data["근거"] ?? data.evidence),
      limits: list(data["한계"] ?? data.limits),
      nextSteps: list(data["다음 할 일"] ?? data.next_steps),
      sources: list(data["사용한 자료"] ?? data.sources),
    },
  };
}

export function fallbackAnswer(raw: string): FinalAnswer {
  return {
    result: raw.trim() || "(모델 응답이 비어 있습니다)",
    evidence: [],
    limits: ["모델이 약속한 형식(JSON)으로 답하지 않아 응답 원문을 그대로 남겼습니다."],
    nextSteps: [],
    sources: [],
  };
}
