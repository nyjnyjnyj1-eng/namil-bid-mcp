// 시험용 가짜 노션·Coral·Hive. 실제 외부 서비스는 호출하지 않습니다.
import { vi } from "vitest";
import type { Env } from "../src/env";

type Json = Record<string, any>;

export const REQ_DS = "req-ds";
export const REC_DS = "rec-ds";

export function makeEnv(over: Partial<Env> = {}): Env {
  return {
    NOTION_TOKEN: "secret_notion_test",
    CORAL_API_KEY: "cb_test_key",
    HIVE_API_KEY: "hive_test_key",
    WEB_PASSCODE: "correct-horse-battery-staple",
    NOTION_REQUESTS_DS_ID: REQ_DS,
    NOTION_RECORDS_DS_ID: REC_DS,
    CORAL_BASE_URL: "https://coral.test/v1",
    CORAL_MODEL: "coral-default",
    HIVE_BASE_URL: "https://hive.test/api/v3",
    HIVE_MODEL: "hive-default",
    HIVE_CHECK_URL: "",
    HIVE_CHECK_BODY: "",
    ...over,
  };
}

let seq = 0;
const newId = () => {
  seq++;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
};

function readShape(rt: Json[] = []): Json[] {
  return rt.map((t) => ({ ...t, plain_text: t.text?.content ?? t.plain_text ?? "", href: t.text?.link?.url ?? null }));
}

function toStoredBlock(b: Json): Json {
  const type = b.type;
  const inner = { ...(b[type] ?? {}) };
  if (inner.rich_text) inner.rich_text = readShape(inner.rich_text);
  return { object: "block", id: newId(), type, has_children: false, [type]: inner };
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
  if (!Object.values(out).some((p: Json) => p.type === "title")) out[schemaTitle] = { type: "title", title: [] };
  return out;
}

export interface FakeOptions {
  coral?: Array<string | { status: number; body: string }>;
  hiveSse?: string;
  hiveCheck?: string;
  corruptRecordWrites?: boolean;
}

export class FakeWorld {
  pages = new Map<string, Json>();
  children = new Map<string, Json[]>();
  calls: { method: string; url: string; body?: any; headers: Record<string, string> }[] = [];
  coralQueue: Array<string | { status: number; body: string }>;

  constructor(private opts: FakeOptions = {}) {
    this.coralQueue = [...(opts.coral ?? [])];
  }

  addPage(opts: { ds?: string; title: string; props?: Json; body?: Json[]; parentPage?: string }): Json {
    const id = newId();
    const props = toStoredProps({ 이름: { title: [{ type: "text", text: { content: opts.title } }] }, ...(opts.props ?? {}) }, "이름");
    if (opts.ds === REQ_DS) {
      delete props["이름"];
      props["요청"] = { type: "title", title: readShape([{ type: "text", text: { content: opts.title } }]) };
    }
    const page = {
      object: "page",
      id,
      url: `https://www.notion.so/${id.replace(/-/g, "")}`,
      created_time: new Date(Date.now() + seq).toISOString(),
      parent: opts.ds ? { type: "data_source_id", data_source_id: opts.ds } : { type: "page_id", page_id: opts.parentPage ?? "root" },
      properties: props,
    };
    this.pages.set(id, page);
    this.children.set(
      id,
      (opts.body ?? []).map((b) => {
        const stored = toStoredBlock(b);
        if (b.children) {
          stored.has_children = true;
          this.children.set(stored.id, b.children.map(toStoredBlock));
        }
        return stored;
      }),
    );
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
    return (this.children.get(pageId) ?? [])
      .map((b) => (b[b.type]?.rich_text ?? []).map((t: Json) => t.plain_text).join(""))
      .join("\n");
  }

  install() {
    vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => this.handle(input, init));
  }

  private ok(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  }

  async handle(input: string, init: RequestInit): Promise<Response> {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, url: input, body, headers: Object.fromEntries(new Headers(init.headers).entries()) });

    if (url.host === "api.notion.com") return this.notion(method, url, body);
    if (url.host === "coral.test") {
      if (url.pathname.endsWith("/models")) return this.ok({ data: [{ id: "coral-default" }] });
      const next = this.coralQueue.shift();
      if (next === undefined) return this.ok({ error: "no scripted reply" }, 500);
      if (typeof next !== "string") return new Response(next.body, { status: next.status });
      return this.ok({ choices: [{ message: { content: next } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    }
    if (url.host === "hive.test") {
      if (url.pathname.endsWith("/chat/completions")) return new Response(this.opts.hiveSse ?? "", { status: 200 });
      return new Response(this.opts.hiveCheck ?? "{}", { status: 200 });
    }
    return new Response("unknown host", { status: 599 });
  }

  private notion(method: string, url: URL, body: any): Response {
    const path = url.pathname.replace(/^\/v1/, "");
    let m: RegExpMatchArray | null;

    if (method === "POST" && (m = path.match(/^\/data_sources\/([^/]+)\/query$/))) {
      const ds = m[1];
      const wanted: string[] = (body?.filter?.or ?? []).map((f: Json) => f.select?.equals);
      const rows = [...this.pages.values()]
        .filter((p) => p.parent?.data_source_id === ds)
        .filter((p) => !wanted.length || wanted.includes(p.properties?.["상태"]?.select?.name))
        .sort((a, b) => a.created_time.localeCompare(b.created_time));
      return this.ok({ results: rows, has_more: false });
    }
    if ((m = path.match(/^\/pages\/([^/]+)$/))) {
      const page = this.pages.get(m[1]);
      if (!page) return this.ok({ object: "error", code: "object_not_found", message: "Could not find page" }, 404);
      if (method === "GET") return this.ok(page);
      if (method === "PATCH") {
        Object.assign(page.properties, toStoredProps(body.properties, "__none__"));
        delete page.properties["__none__"];
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
      let blocks = (body.children ?? []).map(toStoredBlock);
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
        const added = body.children.map(toStoredBlock);
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
