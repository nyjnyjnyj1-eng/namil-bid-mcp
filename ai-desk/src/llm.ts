import { ApiError, Budget } from "./budget";
import { Env } from "./env";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Usage {
  input: number;
  output: number;
}

export interface LlmResult {
  text: string;
  usage: Usage;
}

export type Worker = "Coral" | "Hive LLM" | "Hive 검사";

function usageOf(u: any): Usage {
  return {
    input: Number(u?.prompt_tokens ?? u?.input_tokens ?? 0) || 0,
    output: Number(u?.completion_tokens ?? u?.output_tokens ?? 0) || 0,
  };
}

// Coral Bricks: OpenAI 호환 Chat Completions (https://www.coralbricks.ai/docs)
export async function coralChat(env: Env, budget: Budget, model: string, messages: ChatMessage[]): Promise<LlmResult> {
  if (!env.CORAL_API_KEY) throw new Error("CORAL_API_KEY 비밀값이 설정되지 않았습니다.");
  const res = await budget.fetch(`${env.CORAL_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CORAL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: false, temperature: 0.2 }),
  });
  const text = await res.text();
  if (!res.ok) throw new ApiError("Coral", res.status, text);
  const data = JSON.parse(text);
  return { text: String(data.choices?.[0]?.message?.content ?? ""), usage: usageOf(data.usage) };
}

// Hive: OpenAI 호환 Chat Completions. 공식 문서상 이 경로의 LLM은 스트리밍만 지원합니다.
// (https://docs.thehive.ai/docs/chat-completions-openai-compatible-llms)
export async function hiveChat(env: Env, budget: Budget, model: string, messages: ChatMessage[]): Promise<LlmResult> {
  if (!env.HIVE_API_KEY) throw new Error("HIVE_API_KEY 비밀값이 설정되지 않았습니다.");
  const res = await budget.fetch(`${env.HIVE_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.HIVE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true }),
  });
  const text = await res.text();
  if (!res.ok) throw new ApiError("Hive", res.status, text);
  return parseSse(text);
}

export function parseSse(stream: string): LlmResult {
  let out = "";
  let usage: Usage = { input: 0, output: 0 };
  for (const raw of stream.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let chunk: any;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    out += chunk.choices?.[0]?.delta?.content ?? "";
    if (chunk.usage) usage = usageOf(chunk.usage);
  }
  return { text: out, usage };
}

export function chat(env: Env, budget: Budget, worker: Worker, model: string, messages: ChatMessage[]): Promise<LlmResult> {
  return worker === "Hive LLM" ? hiveChat(env, budget, model, messages) : coralChat(env, budget, model, messages);
}

// Hive 검사(AI 생성 글 감지 등). 공식 V3 요청 형식을 이 환경에서 확인하지 못해서,
// 주소와 본문 틀을 설정값으로 받습니다. 응답은 해석하지 않고 원문 그대로 돌려줍니다.
export async function hiveCheck(env: Env, budget: Budget, text: string): Promise<string> {
  if (!env.HIVE_API_KEY) throw new Error("HIVE_API_KEY 비밀값이 설정되지 않았습니다.");
  if (!env.HIVE_CHECK_URL || !env.HIVE_CHECK_BODY) {
    throw new Error("Hive 검사 설정(HIVE_CHECK_URL, HIVE_CHECK_BODY)이 비어 있습니다. Hive 문서의 요청 형식을 확인해 채워 주세요.");
  }
  const body = env.HIVE_CHECK_BODY.replace('"{{TEXT}}"', JSON.stringify(text));
  JSON.parse(body); // 틀이 올바른 JSON인지 먼저 확인
  const res = await budget.fetch(env.HIVE_CHECK_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.HIVE_API_KEY}`, "Content-Type": "application/json" },
    body,
  });
  const raw = await res.text();
  if (!res.ok) throw new ApiError("Hive", res.status, raw);
  return raw;
}

export async function coralModels(env: Env, budget: Budget): Promise<unknown> {
  if (!env.CORAL_API_KEY) throw new Error("CORAL_API_KEY 비밀값이 설정되지 않았습니다.");
  const res = await budget.fetch(`${env.CORAL_BASE_URL.replace(/\/$/, "")}/models`, {
    headers: { Authorization: `Bearer ${env.CORAL_API_KEY}` },
  });
  const raw = await res.text();
  if (!res.ok) throw new ApiError("Coral", res.status, raw);
  return JSON.parse(raw);
}
