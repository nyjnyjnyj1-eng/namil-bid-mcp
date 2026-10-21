import { markdownToBlocks } from "./blocks";
import { Budget } from "./budget";
import { LIMITS, type Env } from "./env";
import { newLease, runJob, STATUS, tick } from "./engine";
import { coralModels } from "./llm";
import { Notion, prop } from "./notion";
import { PAGE_HTML } from "./page";

const VERSION = "0.1.0";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

// 입력창 암호 확인. 길이가 달라도 걸리는 시간이 같도록 해시끼리 비교합니다.
export async function passcodeOk(env: Env, given: string | null): Promise<boolean> {
  if (!env.WEB_PASSCODE || env.WEB_PASSCODE.length < 16 || !given) return false;
  const [a, b] = await Promise.all([digest(env.WEB_PASSCODE), digest(given)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

interface RunRequest {
  title?: string;
  instruction?: string;
  worker?: string;
  selfResearch?: boolean;
  rounds?: number;
  record?: boolean;
  model?: string;
  queueOnly?: boolean;
}

async function handleRun(env: Env, req: Request): Promise<Response> {
  if (!env.NOTION_TOKEN) return json({ ok: false, error: "NOTION_TOKEN 비밀값이 설정되지 않았습니다." }, 500);
  let body: RunRequest;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "요청 형식이 올바르지 않습니다." }, 400);
  }
  const instruction = (body.instruction ?? "").trim();
  if (!instruction) return json({ ok: false, error: "지시서를 입력해 주세요." }, 400);
  if (instruction.length > 20000) return json({ ok: false, error: "지시서는 20,000자 이하로 입력해 주세요." }, 400);

  const worker = ["Coral", "Hive LLM", "Hive 검사"].includes(body.worker ?? "") ? body.worker! : "Coral";
  const rounds = Math.max(1, Math.min(LIMITS.maxRounds, Math.floor(Number(body.rounds) || LIMITS.defaultRounds)));
  const title = (body.title ?? "").trim() || instruction.split("\n")[0].slice(0, 60);

  const budget = new Budget(LIMITS.subrequests);
  const notion = new Notion(env.NOTION_TOKEN, budget);
  const lease = newLease(null);
  const row = await notion.createPage(
    env.NOTION_REQUESTS_DS_ID,
    {
      요청: prop.title(title),
      상태: prop.select(body.queueOnly ? STATUS.waiting : STATUS.running),
      작업자: prop.select(worker),
      자체조사: prop.checkbox(Boolean(body.selfResearch)),
      "최대 조사 횟수": prop.number(rounds),
      "노션 기록": prop.checkbox(Boolean(body.record)),
      요청자: prop.select("입력창"),
      모델: prop.text((body.model ?? "").trim()),
      "내부 상태": prop.text(body.queueOnly ? "" : JSON.stringify(lease)),
    },
    markdownToBlocks(instruction),
  );
  if (body.queueOnly) {
    return json({ ok: true, status: STATUS.waiting, rowUrl: row.url, message: "요청함에 넣었습니다. 1분 안에 실행됩니다." });
  }
  // 브라우저가 기다리는 동안 바로 실행합니다. 중간에 창을 닫으면 lease 시간이 지난 뒤 1분 주기 실행이 이어받습니다.
  const outcome = await runJob(env, notion, budget, row, lease);
  return json({ ok: outcome.status !== STATUS.failed, ...outcome });
}

function health(env: Env): Response {
  return json({
    ok: true,
    version: VERSION,
    secrets: {
      NOTION_TOKEN: Boolean(env.NOTION_TOKEN),
      CORAL_API_KEY: Boolean(env.CORAL_API_KEY),
      HIVE_API_KEY: Boolean(env.HIVE_API_KEY),
      WEB_PASSCODE: Boolean(env.WEB_PASSCODE && env.WEB_PASSCODE.length >= 16),
    },
    settings: {
      NOTION_REQUESTS_DS_ID: Boolean(env.NOTION_REQUESTS_DS_ID),
      NOTION_RECORDS_DS_ID: Boolean(env.NOTION_RECORDS_DS_ID),
      CORAL_MODEL: env.CORAL_MODEL,
      HIVE_MODEL: env.HIVE_MODEL,
      HIVE_CHECK: Boolean(env.HIVE_CHECK_URL && env.HIVE_CHECK_BODY),
    },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "GET" && url.pathname === "/") {
        return new Response(PAGE_HTML, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
          },
        });
      }
      if (req.method === "GET" && url.pathname === "/health") return health(env);

      if (url.pathname.startsWith("/api/")) {
        if (!(await passcodeOk(env, req.headers.get("x-desk-passcode")))) {
          return json({ ok: false, error: "암호가 맞지 않거나 WEB_PASSCODE(16자 이상)가 설정되지 않았습니다." }, 401);
        }
        if (req.method === "POST" && url.pathname === "/api/run") return await handleRun(env, req);
        if (req.method === "GET" && url.pathname === "/api/models") {
          return json({ ok: true, coral: await coralModels(env, new Budget(2)) });
        }
      }
      return json({ ok: false, error: "없는 주소입니다." }, 404);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(message);
      return json({ ok: false, error: message }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      tick(env)
        .then((r) => console.log("tick:", r))
        .catch((e) => console.error("tick 오류:", e instanceof Error ? e.message : e)),
    );
  },
} satisfies ExportedHandler<Env>;
