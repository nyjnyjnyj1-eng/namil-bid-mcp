import { WorkerEntrypoint } from "cloudflare:workers";
import { Budget } from "./budget";
import { Env, LIMITS } from "./env";
import { firstLine, JobInput, JobView } from "./job";
import { sweep } from "./intake";
import { Notion, pageTitle } from "./notion";
import { autoOrder, probe, ProviderId, WorkerChoice } from "./providers";
import { boardStub, runnerStub } from "./runner";
import { clip, cleanEnv, errorMessage, json, passcodeOk } from "./util";
import PAGE_HTML from "./web/page.html";
import { APPLE_ICON_PNG_BASE64, ICON_SVG, MANIFEST } from "./web/assets";

export { Board, JobRunner } from "./runner";

export const VERSION = "2.0.0";

export interface SubmitRequest {
  text?: string;
  title?: string;
  worker?: string;
  notionSearch?: boolean;
  save?: boolean;
  rounds?: number;
  model?: string;
}

type Submitted = { ok: true; job: JobView } | { ok: false; status: number; error: string };

const WORKERS: WorkerChoice[] = ["auto", "coral", "hive", "free", "hive-check"];
const JOB_ID = /^(web|row)-[0-9a-f-]{36}$/;

export async function submitJob(env: Env, body: SubmitRequest): Promise<Submitted> {
  const text = (body.text ?? "").trim();
  if (!text) return { ok: false, status: 400, error: "요청 내용을 입력해 주세요." };
  if (text.length > LIMITS.maxInstructionChars) {
    return { ok: false, status: 400, error: `요청은 ${LIMITS.maxInstructionChars.toLocaleString()}자 이하로 입력해 주세요.` };
  }
  const worker = WORKERS.includes(body.worker as WorkerChoice) ? (body.worker as WorkerChoice) : "auto";
  const save = Boolean(body.save);
  const notionSearch = Boolean(body.notionSearch);
  if ((save || notionSearch) && !env.NOTION_TOKEN) {
    return { ok: false, status: 400, error: "노션 연결(NOTION_TOKEN)이 없어 노션 기능을 쓸 수 없습니다." };
  }
  if (worker === "hive-check" && !(env.HIVE_CHECK_URL && env.HIVE_CHECK_BODY)) {
    return { ok: false, status: 400, error: "Hive 검사 설정이 아직 없습니다." };
  }
  const rounds = Math.max(1, Math.min(LIMITS.maxRounds, Math.floor(Number(body.rounds) || LIMITS.defaultRounds)));
  const input: JobInput = {
    source: "web",
    title: clip((body.title ?? "").trim() || firstLine(text), 60),
    text,
    worker,
    notionSearch,
    save,
    rounds,
    model: (body.model ?? "").trim() || undefined,
    requester: "웹",
  };
  const id = `web-${crypto.randomUUID()}`;
  const job = await runnerStub(env, id).start(input, id);
  return { ok: true, job };
}

export async function getJob(env: Env, id: string): Promise<JobView | null> {
  if (!JOB_ID.test(id)) return null;
  return runnerStub(env, id).view();
}

export async function listJobs(env: Env) {
  const board = boardStub(env);
  const [jobs, health] = await Promise.all([board.list(), board.health()]);
  return {
    jobs,
    health,
    features: {
      notion: Boolean(env.NOTION_TOKEN),
      hiveCheck: Boolean(env.HIVE_CHECK_URL && env.HIVE_CHECK_BODY),
    },
    notionHome: env.NOTION_HOME_URL ?? null,
    autoOrder: autoOrder(env),
    version: VERSION,
  };
}

// 연결 점검: 모델마다 아주 짧게 물어보고, 노션은 실행기가 읽을 수 있는 페이지를 몇 개 보여 줍니다.
export async function runCheck(env: Env) {
  const budget = new Budget(LIMITS.subrequests);
  const ids: ProviderId[] = ["coral", "hive", "free"];
  const results = await Promise.all(ids.map((p) => probe(env, budget, p)));
  const board = boardStub(env);
  await Promise.all(ids.map((p, i) => board.setHealth(p, results[i]).catch(() => {})));
  let notion: { ok: boolean; reason?: string; pages?: string[] };
  if (!env.NOTION_TOKEN) notion = { ok: false, reason: "노션 연결(NOTION_TOKEN)이 없습니다" };
  else {
    try {
      const r = await new Notion(env.NOTION_TOKEN, budget).search("", 25);
      const skip = new Set([env.NOTION_REQUESTS_DS_ID, env.NOTION_RECORDS_DS_ID]);
      const pages = (r.results ?? [])
        .filter((p: any) => !skip.has(p.parent?.data_source_id))
        .map((p: any) => pageTitle(p))
        .slice(0, 12);
      notion = { ok: true, pages };
    } catch (e) {
      notion = { ok: false, reason: errorMessage(e) };
    }
  }
  return {
    coral: results[0],
    hive: results[1],
    free: results[2],
    notion,
    hiveCheck: Boolean(env.HIVE_CHECK_URL && env.HIVE_CHECK_BODY),
  };
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
      FREE_MODEL: env.FREE_MODEL,
      AUTO_ORDER: env.AUTO_ORDER ?? "coral,hive,free",
      HIVE_CHECK: Boolean(env.HIVE_CHECK_URL && env.HIVE_CHECK_BODY),
      WORKERS_AI: Boolean(env.AI),
    },
  });
}

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function pngResponse(): Response {
  const bin = Uint8Array.from(atob(APPLE_ICON_PNG_BASE64), (c) => c.charCodeAt(0));
  return new Response(bin, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
}

export async function handleFetch(req: Request, rawEnv: Env): Promise<Response> {
  const env = cleanEnv(rawEnv);
  const url = new URL(req.url);
  const path = url.pathname;
  try {
    if (req.method === "GET") {
      if (path === "/" || path === "/index.html") return new Response(PAGE_HTML, { headers: PAGE_HEADERS });
      if (path === "/manifest.webmanifest") {
        return new Response(MANIFEST, { headers: { "Content-Type": "application/manifest+json; charset=utf-8" } });
      }
      if (path === "/icon.svg") return new Response(ICON_SVG, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } });
      if (path === "/apple-touch-icon.png" || path === "/icon-180.png") return pngResponse();
      if (path === "/health") return health(env);
    }

    if (path.startsWith("/api/")) {
      if (!(await passcodeOk(env.WEB_PASSCODE, req.headers.get("x-desk-passcode")))) {
        return json({ ok: false, error: "암호가 맞지 않거나, 실행기에 입력창 암호(WEB_PASSCODE, 16자 이상)가 설정되지 않았습니다." }, 401);
      }
      if (path === "/api/jobs" && req.method === "GET") return json({ ok: true, ...(await listJobs(env)) });
      if (path === "/api/jobs" && req.method === "POST") {
        let body: SubmitRequest;
        try {
          body = await req.json();
        } catch {
          return json({ ok: false, error: "요청 형식이 올바르지 않습니다." }, 400);
        }
        const r = await submitJob(env, body);
        return r.ok ? json(r) : json(r, r.status);
      }
      const m = path.match(/^\/api\/jobs\/([^/]+)$/);
      if (m && req.method === "GET") {
        const job = await getJob(env, decodeURIComponent(m[1]));
        return job ? json({ ok: true, job }) : json({ ok: false, error: "작업을 찾지 못했습니다." }, 404);
      }
      if (path === "/api/check" && req.method === "GET") return json({ ok: true, ...(await runCheck(env)) });
    }
    return json({ ok: false, error: "없는 주소입니다." }, 404);
  } catch (e) {
    console.error(errorMessage(e));
    return json({ ok: false, error: errorMessage(e) }, 500);
  }
}

// 같은 Cloudflare 계정의 다른 Worker(예: 입찰 서버)가 인터넷을 거치지 않고 작업을 맡기는 내부 입구.
// 외부에서는 이 입구를 부를 수 없습니다(서비스 바인딩으로만 연결).
export class DeskAPI extends WorkerEntrypoint<Env> {
  async submit(body: SubmitRequest): Promise<Submitted> {
    return submitJob(cleanEnv(this.env), body);
  }
  async view(id: string): Promise<JobView | null> {
    return getJob(cleanEnv(this.env), id);
  }
  async list() {
    return listJobs(cleanEnv(this.env));
  }
  async check() {
    return runCheck(cleanEnv(this.env));
  }
}

export default {
  fetch: handleFetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      sweep(cleanEnv(env))
        .then((r) => console.log("sweep:", r))
        .catch((e) => console.error("sweep 오류:", errorMessage(e))),
    );
  },
} satisfies ExportedHandler<Env>;
