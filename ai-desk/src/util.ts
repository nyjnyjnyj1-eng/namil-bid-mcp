import type { Env } from "./env";

// 한국 시간 "YYYY-MM-DD HH:mm". 계산 시간을 아끼려고 Intl을 쓰지 않습니다(한국은 서머타임 없음).
export function kst(d: Date | number = Date.now()): string {
  const t = new Date((typeof d === "number" ? d : d.getTime()) + 9 * 3600_000).toISOString();
  return `${t.slice(0, 10)} ${t.slice(11, 16)}`;
}

export function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

// 입력창 암호 확인. 길이와 관계없이 같은 시간이 걸리도록 해시끼리 비교합니다.
export async function passcodeOk(expected: string | undefined, given: string | null): Promise<boolean> {
  if (!expected || expected.length < 16 || !given) return false;
  const [a, b] = await Promise.all([digest(expected), digest(given.trim())]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// 붙여넣을 때 딸려 온 앞뒤 공백·줄바꿈 때문에 인증이 실패하지 않도록 비밀값을 다듬습니다.
// 원래 env를 그대로 두고(바인딩은 원본에서 찾음) 비밀값만 다듬은 값으로 덮습니다.
export function cleanEnv(env: Env): Env {
  const t = (v?: string) => (typeof v === "string" ? v.trim() : v);
  const out = Object.create(env) as Env;
  out.NOTION_TOKEN = t(env.NOTION_TOKEN);
  out.CORAL_API_KEY = t(env.CORAL_API_KEY);
  out.HIVE_API_KEY = t(env.HIVE_API_KEY);
  out.WEB_PASSCODE = t(env.WEB_PASSCODE);
  return out;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
