import { ApiError, Budget, BudgetError, TransientError } from "./budget";
import { Env, LIMITS } from "./env";

// 답을 만들어 주는 곳(모델 제공자). 자동 모드는 AUTO_ORDER 순서대로 시도하고,
// 키·결제 문제처럼 기다려도 안 풀리는 곳은 건너뛰어 다음으로 넘어갑니다.
export type ProviderId = "coral" | "hive" | "free";
export type WorkerChoice = "auto" | ProviderId | "hive-check";

export const PROVIDER_LABEL: Record<ProviderId, string> = { coral: "Coral", hive: "Hive", free: "무료 모델" };
export const WORKER_LABEL: Record<WorkerChoice, string> = {
  auto: "자동",
  coral: "Coral",
  hive: "Hive",
  free: "무료 모델",
  "hive-check": "Hive 검사",
};

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Usage {
  input: number;
  output: number;
}

export interface ChatResult {
  text: string;
  usage: Usage;
  provider: ProviderId;
  model: string;
  skipped: string[];
}

// 기다려도 풀리지 않는 문제(키 오류, 카드 미등록, 무료 사용량 소진 등)
export class ProviderUnavailable extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly reason: string,
  ) {
    super(`${PROVIDER_LABEL[provider]}: ${reason}`);
    this.name = "ProviderUnavailable";
  }
}

export interface HealthEntry {
  ok: boolean;
  reason?: string;
  at: number;
}
export type Health = Partial<Record<ProviderId, HealthEntry>>;

export interface HealthStore {
  get(): Promise<Health>;
  set(provider: ProviderId, entry: HealthEntry): Promise<void>;
}

export function workerFromName(name?: string | null): WorkerChoice {
  switch ((name ?? "").trim()) {
    case "Coral":
    case "coral":
      return "coral";
    case "Hive":
    case "Hive LLM":
    case "hive":
      return "hive";
    case "무료 모델":
    case "무료":
    case "free":
      return "free";
    case "Hive 검사":
    case "hive-check":
      return "hive-check";
    default:
      return "auto";
  }
}

export function autoOrder(env: Env): ProviderId[] {
  const valid = new Set<ProviderId>(["coral", "hive", "free"]);
  const order = (env.AUTO_ORDER || "coral,hive,free")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is ProviderId => valid.has(s as ProviderId));
  return order.length ? [...new Set(order)] : ["coral", "hive", "free"];
}

export function defaultModel(env: Env, p: ProviderId): string {
  return p === "coral" ? env.CORAL_MODEL : p === "hive" ? env.HIVE_MODEL : env.FREE_MODEL;
}

const snippet = (s: string) => s.replace(/\s+/g, " ").slice(0, 160);
const trimSlash = (u: string) => u.replace(/\/+$/, "");

function classifyHttp(p: ProviderId, status: number, body: string): Error {
  const lower = body.toLowerCase();
  if (status === 401) return new ProviderUnavailable(p, "키가 맞지 않거나 만료되었습니다");
  if (status === 402) return new ProviderUnavailable(p, "결제 또는 크레딧이 필요합니다");
  if (status === 403) {
    if (lower.includes("card")) return new ProviderUnavailable(p, "계정에 카드 등록이 필요합니다");
    return new ProviderUnavailable(p, `권한이 없습니다 (${snippet(body)})`);
  }
  if (status === 404) return new ProviderUnavailable(p, `모델을 찾지 못했습니다 (${snippet(body)})`);
  if (status === 429) {
    if (/quota|credit|insufficient|balance|billing/.test(lower)) return new ProviderUnavailable(p, "사용 한도 또는 크레딧이 부족합니다");
    return new TransientError(`${PROVIDER_LABEL[p]}: 요청이 몰려 잠시 거절됨`);
  }
  if (status >= 500) return new TransientError(`${PROVIDER_LABEL[p]}: 서버 오류 (${status})`);
  return new ApiError(PROVIDER_LABEL[p], status, body);
}

function networkError(p: ProviderId, e: unknown): Error {
  if (e instanceof BudgetError) return e;
  const name = (e as Error)?.name ?? "";
  if (name === "TimeoutError" || name === "AbortError") return new TransientError(`${PROVIDER_LABEL[p]}: 응답 시간이 너무 깁니다`);
  return new TransientError(`${PROVIDER_LABEL[p]}: 연결 오류 (${(e as Error)?.message ?? e})`);
}

export function contentOf(data: any): string {
  const c = data?.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p: any) => p?.text ?? "").join("");
  if (typeof data?.response === "string") return data.response;
  if (typeof data?.output_text === "string") return data.output_text;
  if (Array.isArray(data?.output)) {
    return data.output
      .flatMap((o: any) => (Array.isArray(o?.content) ? o.content : []))
      .map((p: any) => p?.text ?? "")
      .join("");
  }
  return "";
}

export function usageOf(u: any): Usage {
  return {
    input: Number(u?.prompt_tokens ?? u?.input_tokens ?? 0) || 0,
    output: Number(u?.completion_tokens ?? u?.output_tokens ?? 0) || 0,
  };
}

export function parseSse(stream: string): { text: string; usage: Usage } {
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

interface CallOpts {
  maxTokens?: number;
}

// Coral Bricks: OpenAI 호환 Chat Completions (https://www.coralbricks.ai/docs)
async function callCoral(env: Env, budget: Budget, model: string, messages: ChatMessage[], o: CallOpts) {
  if (!env.CORAL_API_KEY) throw new ProviderUnavailable("coral", "키가 설정되지 않았습니다");
  let res: Response;
  try {
    res = await budget.fetch(`${trimSlash(env.CORAL_BASE_URL)}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CORAL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false, temperature: 0.2, max_tokens: o.maxTokens ?? LIMITS.maxTokens }),
      signal: AbortSignal.timeout(LIMITS.modelTimeoutMs),
    });
  } catch (e) {
    throw networkError("coral", e);
  }
  const text = await res.text();
  if (!res.ok) throw classifyHttp("coral", res.status, text);
  const data = JSON.parse(text);
  return { text: contentOf(data), usage: usageOf(data.usage) };
}

// Hive: OpenAI 호환 Chat Completions. 공식 문서상 이 경로의 LLM은 스트리밍만 지원합니다.
// (https://docs.thehive.ai/docs/chat-completions-openai-compatible-llms)
async function callHive(env: Env, budget: Budget, model: string, messages: ChatMessage[], o: CallOpts) {
  if (!env.HIVE_API_KEY) throw new ProviderUnavailable("hive", "키가 설정되지 않았습니다");
  let res: Response;
  try {
    res = await budget.fetch(`${trimSlash(env.HIVE_BASE_URL)}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.HIVE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: true, max_tokens: o.maxTokens ?? LIMITS.maxTokens }),
      signal: AbortSignal.timeout(LIMITS.modelTimeoutMs),
    });
  } catch (e) {
    throw networkError("hive", e);
  }
  const text = await res.text();
  if (!res.ok) throw classifyHttp("hive", res.status, text);
  return parseSse(text);
}

function classifyAi(e: unknown): Error {
  const msg = String((e as Error)?.message ?? e);
  if (/3036|daily free allocation|neurons/i.test(msg)) {
    return new ProviderUnavailable("free", "오늘 무료 사용량을 다 썼습니다 (매일 오전 9시 초기화)");
  }
  if (/5035|workers paid|upgrade/i.test(msg)) return new ProviderUnavailable("free", "이 모델은 Cloudflare 유료 플랜이 필요합니다");
  if (/5007|no such model|not found/i.test(msg)) return new ProviderUnavailable("free", `모델을 찾지 못했습니다 (${snippet(msg)})`);
  if (/3040|capacity|429|timeout|timed out/i.test(msg)) return new TransientError("무료 모델이 혼잡합니다");
  return new TransientError(`무료 모델 오류 (${snippet(msg)})`);
}

// Cloudflare Workers AI (키 없이 동작, 하루 10,000 neurons 무료)
async function callFree(env: Env, model: string, messages: ChatMessage[], o: CallOpts) {
  if (!env.AI) throw new ProviderUnavailable("free", "Workers AI 연결이 없습니다");
  const input: Record<string, unknown> = { messages, max_tokens: o.maxTokens ?? LIMITS.maxTokens, temperature: 0.2 };
  // 생각 과정을 길게 쓰느라 답이 비는 일을 막습니다.
  if (/gemma|glm|qwen3/i.test(model)) input.chat_template_kwargs = { enable_thinking: false };
  if (/gpt-oss/i.test(model)) input.reasoning_effort = "low";
  let out: any;
  try {
    out = await (env.AI as any).run(model, input);
  } catch (e) {
    throw classifyAi(e);
  }
  return { text: contentOf(out), usage: usageOf(out?.usage) };
}

export async function callProvider(
  env: Env,
  budget: Budget,
  p: ProviderId,
  model: string,
  messages: ChatMessage[],
  o: CallOpts = {},
): Promise<{ text: string; usage: Usage }> {
  if (p === "coral") return callCoral(env, budget, model, messages, o);
  if (p === "hive") return callHive(env, budget, model, messages, o);
  return callFree(env, model, messages, o);
}

// 정해진 순서대로 묻습니다. 자동 모드에서는 막힌 곳을 건너뛰고 다음으로 넘어갑니다.
export async function chat(
  env: Env,
  budget: Budget,
  choice: WorkerChoice,
  modelOverride: string | undefined,
  messages: ChatMessage[],
  health: HealthStore,
): Promise<ChatResult> {
  if (choice === "hive-check") throw new Error("Hive 검사는 대화 모델이 아닙니다.");
  const explicit = choice !== "auto";
  const order: ProviderId[] = explicit ? [choice] : autoOrder(env);
  const known = explicit ? {} : await health.get().catch(() => ({}) as Health);
  const skipped: string[] = [];
  const now = Date.now();
  // 최근에 막힌 것으로 확인된 곳은 건너뜁니다(마지막 하나는 항상 시도).
  const candidates = order.filter((p, i) => {
    const h = (known as Health)[p];
    if (h && !h.ok && now - h.at < LIMITS.healthTtlMs && i < order.length - 1) {
      skipped.push(`${PROVIDER_LABEL[p]}: ${h.reason ?? "사용 불가"}`);
      return false;
    }
    return true;
  });

  let transient: Error | undefined;
  for (const p of candidates) {
    const model = explicit && modelOverride ? modelOverride : defaultModel(env, p);
    try {
      const r = await callProvider(env, budget, p, model, messages);
      if (!r.text.trim()) throw new TransientError(`${PROVIDER_LABEL[p]}: 빈 답을 보냈습니다`);
      await health.set(p, { ok: true, at: Date.now() }).catch(() => {});
      return { ...r, provider: p, model, skipped };
    } catch (e) {
      if (e instanceof BudgetError) throw e;
      if (e instanceof ProviderUnavailable) {
        await health.set(p, { ok: false, reason: e.reason, at: Date.now() }).catch(() => {});
        if (explicit) throw e;
        skipped.push(`${PROVIDER_LABEL[p]}: ${e.reason}`);
        continue;
      }
      if (e instanceof TransientError && !explicit) {
        // 자동 모드에서는 잠깐의 문제도 다음 곳으로 넘겨 바로 답을 받습니다.
        skipped.push(`${e.message}`);
        transient = e;
        continue;
      }
      throw e;
    }
  }
  if (transient) throw new TransientError(`모든 모델이 잠시 응답하지 않습니다 (${skipped.join(" / ")})`);
  throw new Error(`지금 쓸 수 있는 모델이 없습니다: ${skipped.join(" / ")}`);
}

// 연결 점검용 아주 짧은 호출(답 1~2토큰).
export async function probe(env: Env, budget: Budget, p: ProviderId): Promise<HealthEntry> {
  try {
    await callProvider(env, budget, p, defaultModel(env, p), [{ role: "user", content: "ok" }], { maxTokens: 2 });
    return { ok: true, at: Date.now() };
  } catch (e) {
    if (e instanceof ProviderUnavailable) return { ok: false, reason: e.reason, at: Date.now() };
    return { ok: false, reason: (e as Error)?.message ?? String(e), at: Date.now() };
  }
}

// Hive 검사(AI 생성 글 감지 등). V3 요청 형식은 설정값(주소·본문 틀)으로 받습니다.
export async function hiveCheck(env: Env, budget: Budget, text: string): Promise<string> {
  if (!env.HIVE_API_KEY) throw new ProviderUnavailable("hive", "키가 설정되지 않았습니다");
  if (!env.HIVE_CHECK_URL || !env.HIVE_CHECK_BODY) {
    throw new Error("Hive 검사 설정(HIVE_CHECK_URL, HIVE_CHECK_BODY)이 비어 있습니다.");
  }
  const body = env.HIVE_CHECK_BODY.replace('"{{TEXT}}"', JSON.stringify(text));
  JSON.parse(body); // 틀이 올바른 JSON인지 먼저 확인
  let res: Response;
  try {
    res = await budget.fetch(env.HIVE_CHECK_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.HIVE_API_KEY}`, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(LIMITS.modelTimeoutMs),
    });
  } catch (e) {
    throw networkError("hive", e);
  }
  const raw = await res.text();
  if (!res.ok) throw classifyHttp("hive", res.status, raw);
  return raw;
}
