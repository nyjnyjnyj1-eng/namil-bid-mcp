import { ApiError, Budget } from "./budget";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2025-09-03";

export type Json = Record<string, any>;

export interface ChildList {
  blocks: Json[];
  truncated: boolean;
}

// 노션 공식 API 호출. 실행기는 새 페이지 만들기·아래에 덧붙이기·속성 바꾸기만 하고,
// 기존 블록을 고치거나 지우는 호출은 만들지 않습니다.
export class Notion {
  constructor(
    private readonly token: string,
    private readonly budget: Budget,
  ) {}

  private async call(method: string, path: string, body?: unknown, retried = false): Promise<Json> {
    const res = await this.budget.fetch(`${NOTION_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status === 429 && !retried) {
      const wait = Math.min(Number(res.headers.get("Retry-After") ?? "1") || 1, 5);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return this.call(method, path, body, true);
    }
    if (!res.ok) throw new ApiError("노션", res.status, text);
    return text ? JSON.parse(text) : {};
  }

  queryDataSource(dataSourceId: string, body: Json): Promise<Json> {
    return this.call("POST", `/data_sources/${dataSourceId}/query`, body);
  }

  getPage(pageId: string): Promise<Json> {
    return this.call("GET", `/pages/${pageId}`);
  }

  updatePage(pageId: string, properties: Json): Promise<Json> {
    return this.call("PATCH", `/pages/${pageId}`, { properties });
  }

  async listChildren(blockId: string, maxPages = 2): Promise<ChildList> {
    const blocks: Json[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const qs = new URLSearchParams({ page_size: "100" });
      if (cursor) qs.set("start_cursor", cursor);
      const data = await this.call("GET", `/blocks/${blockId}/children?${qs}`);
      blocks.push(...(data.results ?? []));
      if (!data.has_more) return { blocks, truncated: false };
      cursor = data.next_cursor;
    }
    return { blocks, truncated: true };
  }

  // 아래에 덧붙이기. 노션은 한 번에 100블록까지 받습니다.
  async appendChildren(blockId: string, children: Json[]): Promise<Json[]> {
    const written: Json[] = [];
    for (let i = 0; i < children.length; i += 100) {
      const data = await this.call("PATCH", `/blocks/${blockId}/children`, {
        children: children.slice(i, i + 100),
      });
      written.push(...(data.results ?? []));
    }
    return written;
  }

  async createPage(dataSourceId: string, properties: Json, children: Json[]): Promise<Json> {
    const page = await this.call("POST", "/pages", {
      parent: { type: "data_source_id", data_source_id: dataSourceId },
      properties,
      children: children.slice(0, 100),
    });
    if (children.length > 100) await this.appendChildren(page.id, children.slice(100));
    return page;
  }

  search(query: string, pageSize = 6): Promise<Json> {
    return this.call("POST", "/search", {
      query,
      filter: { property: "object", value: "page" },
      page_size: pageSize,
    });
  }
}

export function pageTitle(page: Json): string {
  for (const prop of Object.values<Json>(page.properties ?? {})) {
    if (prop?.type === "title") return plain(prop.title);
  }
  return "(제목 없음)";
}

export function plain(richText: Json[] | undefined): string {
  return (richText ?? []).map((t) => t.plain_text ?? t.text?.content ?? "").join("");
}

// 노션 속성 값 만들기
export const prop = {
  title: (s: string) => ({ title: textRuns(s) }),
  text: (s: string) => ({ rich_text: textRuns(s) }),
  select: (name: string) => ({ select: { name } }),
  checkbox: (v: boolean) => ({ checkbox: v }),
  number: (n: number) => ({ number: n }),
  url: (u: string | null) => ({ url: u }),
  date: (iso: string) => ({ date: { start: iso } }),
  relation: (ids: string[]) => ({ relation: ids.map((id) => ({ id })) }),
};

// 노션 글 조각은 2000자까지라서 나눠 담습니다.
export function textRuns(s: string, link?: string): Json[] {
  const runs: Json[] = [];
  for (let i = 0; i < s.length; i += 2000) {
    const content = s.slice(i, i + 2000);
    runs.push({ type: "text", text: link ? { content, link: { url: link } } : { content } });
  }
  return runs.slice(0, 100);
}
