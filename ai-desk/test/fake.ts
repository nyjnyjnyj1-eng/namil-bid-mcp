// 시험용 가짜 노션·Coral·Hive·Workers AI·Durable Object. 실제 외부 서비스는 호출하지 않습니다.
import { vi } from "vitest";
import type { Env } from "../src/env";
import { Board, JobRunner } from "../src/runner";

type Json = Record<string, any>;

export const REQ_DS = "req-ds";
export const REC_DS = "rec-ds";

let seq = 0;
const newId = () => {
  seq++;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
};

function readShape(rt: Json[] = []): Json[] {
  return rt.map((t) => ({ ...t, plain_text: t.text?.content ?? t.plain_text ?? "", href: t.text?.link?.url ?? null }));
}

function toStoredProps(props: Json, schemaTitle: string): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries<Json>(props)) {
    if (v.title) out[k] = { type: "title", title: readShape(v.title) };
    else if (v.rich_text) out[k] = { type: "rich_text", rich_text: readShape(v.rich_text) };
    else if ("select" in v) out[k] = { type: "select", select: v.select };
    else if ("checkbox" in v) out[k] = { type: "checkbox", checkbox: v.checkbox };
    else if ("number" in v) out[k] = { type: "number", number: v.number };
    else if ("url" in v) out[k] = { type: "url", url: v.url };
    else if ("date" in v) out[k] = { type: "date", date: v.date };
    else if ("relation" in v) out[k] = { type: "relation", relation: v.relation };
  }
  if (schemaTitle && !Object.values(out).some((p: Json) => p.type === "title")) out[schemaTitle] = { type: "title", title: [] };
  return out;
}

type Scripted = string | { status: number; body: string };

export interface FakeOptions {
  coral?: Scripted[];
  hiveSse?: string | { status: number; body: string };
  hiveCheck?: string;
  // 무료 모델(Workers AI) 응답: 글이면 답, Error면 그 오류를 던짐
  ai?: Array<string | Error>;
  corruptRecordWrites?: boolean;
  // 이 경로로 가는 노션 요청을 정해진 횟수만큼 500으로 실패시킴 (예: "GET /blocks/<id>/children")
  notionFailures?: Record<string, number>;
}

export class FakeWorld {
  pages = new Map<string, Json>();
  children = new Map<string, Json[]>();
  calls: { method: string; url: string; body?: any; headers: Record<string, string> }[] = [];
  aiCalls: { model: string; input: any }[] = [];
  coralQueue: Scripted[];
  aiQueue: Array<string | Error>;
  notionFailures: Record<string, number>;

  constructor(private opts: FakeOptions = {}) {
    this.coralQueue = [...(opts.coral ?? [])];
    this.aiQueue = [...(opts.ai ?? [])];
    this.notionFailures = { ...(opts.notionFailures ?? {}) };
  }

  // 블록을 노션처럼 저장합니다. 표는 행을 따로 저장하고 표에는 has_children만 남깁니다.
  storeBlock(b: Json): Json {
    const type = b.type;
    const inner = { ...(b[type] ?? {}) };
    if (inner.rich_text) inner.rich_text = readShape(inner.rich_text);
    if (type === "table_row") inner.cells = (inner.cells ?? []).map((c: Json[]) => readShape(c));
    const kids: Json[] | undefined = b.children ?? inner.children;
    delete inner.children;
    const stored: Json = { object: "block", id: newId(), type, has_children: false, [type]: inner };
    if (kids?.length) {
      stored.has_children = true;
      this.children.set(stored.id, kids.map((k) => this.storeBlock(k)));
    }
    return stored;
  }

  addPage(opts: { ds?: string; title: string; props?: Json; body?: Json[]; parentPage?: string }): Json {
    const id = newId();
    const titleKey = opts.ds === REQ_DS ? "요청" : opts.ds === REC_DS ? "제목" : "이름";
    const props = toStoredProps({ [titleKey]: { title: [{ type: "text", text: { content: opts.title } }] }, ...(opts.props ?? {}) }, titleKey);
    const page = {
      object: "page",
      id,
      url: `https://www.notion.so/${id.replace(/-/g, "")}`,
      created_time: new Date(Date.now() + seq).toISOString(),
      parent: opts.ds ? { type: "data_source_id", data_source_id: opts.ds } : { type: "page_id", page_id: opts.parentPage ?? "root" },
      properties: props,
    };
    this.pages.set(id, page);
    this.children.set(id, (opts.body ?? []).map((b) => this.storeBlock(b)));
    return page;
  }

  prop(pageId: string, name: string): any {
    const p = this.pages.get(pageId)?.properties?.[name];
    if (!p) return undefined;
    if (p.type === "select") return p.select?.name;
    if (p.type === "rich_text" || p.type === "title") return (p[p.type] as Json[]).map((t) => t.plain_text).join("");
    return p[p.type];
  }

  text(pageId: string): string {
    const out: string[] = [];
    for (const b of this.children.get(pageId) ?? []) {
      out.push((b[b.type]?.rich_text ?? []).map((t: Json) => t.plain_text).join(""));
      if (b.type === "table") {
        for (const r of this.children.get(b.id) ?? []) out.push((r.table_row?.cells ?? []).map((c: Json[]) => c.map((t) => t.plain_text).join("")).join(" | "));
      }
    }
    return out.join("\n");
  }

  pagesIn(ds: string): Json[] {
    return [...this.pages.values()].filter((p) => p.parent?.data_source_id === ds);
  }

  notionCalls() {
    return this.calls.filter((c) => c.url.startsWith("https://api.notion.com"));
  }

  install() {
    vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => this.handle(input, init));
  }

  ai() {
    return {
      run: async (model: string, input: any) => {
        this.aiCalls.push({ model, input: structuredClone(input) });
        const next = this.aiQueue.shift();
        if (next === undefined) throw new Error("no scripted AI reply");
        if (next instanceof Error) throw next;
        return { choices: [{ message: { role: "assistant", content: next } }], usage: { prompt_tokens: 50, completion_tokens: 10 } };
      },
    };
  }

  private ok(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  }

  async handle(input: string, init: RequestInit): Promise<Response> {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, url: input, body, headers: Object.fromEntries(new Headers(init.headers).entries()) });

    if (url.host === "api.notion.com") {
      const key = `${method} ${url.pathname.replace(/^\/v1/, "")}`;
      if (this.notionFailures[key] > 0) {
        this.notionFailures[key]--;
        return this.ok({ object: "error", code: "internal_server_error" }, 500);
      }
      return this.notion(method, url, body);
    }
    if (url.host === "coral.test") {
      const next = this.coralQueue.shift();
      if (next === undefined) return this.ok({ error: "no scripted reply" }, 500);
      if (typeof next !== "string") return new Response(next.body, { status: next.status });
      return this.ok({ choices: [{ message: { content: next } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    }
    if (url.host === "hive.test") {
      if (url.pathname.endsWith("/chat/completions")) {
        const h = this.opts.hiveSse;
        if (h && typeof h !== "string") return new Response(h.body, { status: h.status });
        return new Response(h ?? "", { status: 200 });
      }
      return new Response(this.opts.hiveCheck ?? "{}", { status: 200 });
    }
    return new Response("unknown host", { status: 599 });
  }

  private notion(method: string, url: URL, body: any): Response {
    const path = url.pathname.replace(/^\/v1/, "");
    let m: RegExpMatchArray | null;

    if (method === "POST" && (m = path.match(/^\/data_sources\/([^/]+)\/query$/))) {
      const wanted: string[] = (body?.filter?.or ?? []).map((f: Json) => f.select?.equals);
      const rows = this.pagesIn(m[1])
        .filter((p) => !wanted.length || wanted.includes(p.properties?.["상태"]?.select?.name))
        .sort((a, b) => a.created_time.localeCompare(b.created_time));
      return this.ok({ results: rows.slice(0, body?.page_size ?? 100), has_more: false });
    }
    if ((m = path.match(/^\/pages\/([^/]+)$/))) {
      const page = this.pages.get(m[1]);
      if (!page) return this.ok({ object: "error", code: "object_not_found", message: "Could not find page" }, 404);
      if (method === "GET") return this.ok(page);
      if (method === "PATCH") {
        Object.assign(page.properties, toStoredProps(body.properties, ""));
        return this.ok(page);
      }
    }
    if (method === "POST" && path === "/pages") {
      const ds = body.parent.data_source_id;
      const id = newId();
      const page = {
        object: "page",
        id,
        url: `https://www.notion.so/${id.replace(/-/g, "")}`,
        created_time: new Date(Date.now() + seq).toISOString(),
        parent: body.parent,
        properties: toStoredProps(body.properties, ds === REQ_DS ? "요청" : "제목"),
      };
      this.pages.set(id, page);
      let blocks = (body.children ?? []).map((b: Json) => this.storeBlock(b));
      if (this.opts.corruptRecordWrites && ds === REC_DS) blocks = blocks.slice(1);
      this.children.set(id, blocks);
      return this.ok(page);
    }
    if ((m = path.match(/^\/blocks\/([^/]+)\/children$/))) {
      const list = this.children.get(m[1]);
      if (!list) return this.ok({ object: "error", code: "object_not_found" }, 404);
      if (method === "GET") {
        const size = Number(url.searchParams.get("page_size") ?? 100);
        const start = Number(url.searchParams.get("start_cursor") ?? 0);
        const slice = list.slice(start, start + size);
        const more = start + size < list.length;
        return this.ok({ results: slice, has_more: more, next_cursor: more ? String(start + size) : null });
      }
      if (method === "PATCH") {
        const added = body.children.map((b: Json) => this.storeBlock(b));
        list.push(...added);
        return this.ok({ results: added });
      }
    }
    if (method === "POST" && path === "/search") {
      const q = String(body.query ?? "");
      const results = [...this.pages.values()].filter((p) =>
        Object.values<Json>(p.properties).some((v) => v.type === "title" && v.title.map((t: Json) => t.plain_text).join("").includes(q)),
      );
      return this.ok({ results: results.slice(0, body.page_size ?? 10) });
    }
    return this.ok({ object: "error", code: "unsupported", message: `${method} ${path}` }, 400);
  }
}

// ---------- Durable Object 흉내 ----------

export class FakeStorage {
  data = new Map<string, any>();
  alarm: number | null = null;
  async get<T>(k: string): Promise<T | undefined> {
    const v = this.data.get(k);
    return v === undefined ? undefined : structuredClone(v);
  }
  async put(k: string, v: unknown) {
    this.data.set(k, structuredClone(v));
  }
  async delete(k: string) {
    return this.data.delete(k);
  }
  async deleteAll() {
    this.data.clear();
    this.alarm = null;
  }
  async setAlarm(t: number | Date) {
    this.alarm = typeof t === "number" ? t : t.getTime();
  }
  async getAlarm() {
    return this.alarm;
  }
  async deleteAlarm() {
    this.alarm = null;
  }
}

export class FakeNamespace<T> {
  instances = new Map<string, T>();
  constructor(private make: (ctx: any) => T) {}
  idFromName(name: string) {
    return { name, toString: () => name };
  }
  get(id: { name: string }): T {
    if (!this.instances.has(id.name)) this.instances.set(id.name, this.make({ storage: new FakeStorage(), id }));
    return this.instances.get(id.name)!;
  }
}

export interface TestEnv extends Env {
  RUNNER: any;
  BOARD: any;
}

export function makeEnv(world: FakeWorld, over: Partial<Env> = {}): TestEnv {
  const env: any = {
    NOTION_TOKEN: "secret_notion_test",
    CORAL_API_KEY: "cb_test_key",
    HIVE_API_KEY: "hive_test_key",
    WEB_PASSCODE: "correct-horse-battery-staple",
    NOTION_REQUESTS_DS_ID: REQ_DS,
    NOTION_RECORDS_DS_ID: REC_DS,
    NOTION_HOME_URL: "https://www.notion.so/home",
    AUTO_ORDER: "coral,hive,free",
    CORAL_BASE_URL: "https://coral.test/v1",
    CORAL_MODEL: "coral-default",
    HIVE_BASE_URL: "https://hive.test/api/v3",
    HIVE_MODEL: "hive-default",
    FREE_MODEL: "@cf/google/gemma-test",
    HIVE_CHECK_URL: "",
    HIVE_CHECK_BODY: "",
    AI: world.ai(),
    ...over,
  };
  env.RUNNER = new FakeNamespace((ctx) => new JobRunner(ctx, env));
  env.BOARD = new FakeNamespace((ctx) => new Board(ctx, env));
  return env as TestEnv;
}

// 예약된 알람(바로 다음 단계와 2분 안의 재시도)을 모두 차례로 실행합니다.
export async function drain(env: TestEnv, maxSteps = 300): Promise<number> {
  for (let i = 0; i < maxSteps; i++) {
    const due = [...(env.RUNNER as FakeNamespace<JobRunner>).instances.values()].filter((inst: any) => {
      const a = inst.ctx.storage.alarm;
      return a !== null && a <= Date.now() + 120_000;
    });
    if (!due.length) return i;
    for (const inst of due as any[]) {
      inst.ctx.storage.alarm = null;
      await inst.alarm();
    }
  }
  throw new Error("drain: 너무 많은 단계");
}

export function runner(env: TestEnv, id: string): JobRunner {
  return env.RUNNER.get(env.RUNNER.idFromName(id));
}

export function board(env: TestEnv): Board {
  return env.BOARD.get(env.BOARD.idFromName("board"));
}

// ---------- 노션 블록 만들기 ----------

export const para = (text: string) => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: text } }] } });

export const table = (rows: string[][]) => ({
  object: "block",
  type: "table",
  table: { table_width: rows[0]?.length ?? 1, has_column_header: true },
  children: rows.map((cells) => ({
    object: "block",
    type: "table_row",
    table_row: { cells: cells.map((c) => [{ type: "text", text: { content: c }, plain_text: c }]) },
  })),
});

export const mention = (before: string, pageId: string) => ({
  object: "block",
  type: "paragraph",
  paragraph: {
    rich_text: [
      { type: "text", text: { content: before } },
      { type: "mention", mention: { type: "page", page: { id: pageId } }, plain_text: "참고 페이지" },
    ],
  },
});

export const final = (result: string, extra: Json = {}) =>
  JSON.stringify({ action: "final", 결과: result, 근거: ["자료 A"], 한계: [], "다음 할 일": ["다음 단계"], "사용한 자료": ["자료 A"], ...extra });

export function aiError(message: string): Error {
  return new Error(message);
}
