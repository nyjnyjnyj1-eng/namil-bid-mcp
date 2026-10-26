import { Json, Notion, plain } from "./notion";

export const RESULT_HEADING = "실행 결과";

const TEXT_TYPES = [
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "toggle",
  "quote",
  "callout",
  "code",
];

export interface PageText {
  text: string;
  refs: string[];
  skippedNested: number;
}

// 노션 ID(32자리 16진수)를 하이픈 형식으로 맞춥니다. 찾지 못하면 null.
export function notionId(s: string): string | null {
  const dashed = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  // 주소의 제목 부분(예: "My-Page-")과 섞이지 않도록 앞뒤가 16진수가 아닌 32자리만 봅니다.
  const plainIds = s.match(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi);
  const raw = dashed?.[0] ?? plainIds?.at(-1);
  if (!raw) return null;
  const h = raw.replace(/-/g, "").toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// 글 속의 노션 링크(notion.so / notion.site / app.notion.com)에서 페이지 ID를 뽑습니다.
export function notionRefsFromText(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s)\]>"']*notion\.(?:so|site|com)[^\s)\]>"']*/gi)) {
    const id = notionId(m[0].split("?")[0].split("#")[0]);
    if (id) out.add(id);
  }
  return [...out];
}

function refsFromRichText(rt: Json[] | undefined, out: Set<string>) {
  for (const t of rt ?? []) {
    if (t.type === "mention" && t.mention?.type === "page" && t.mention.page?.id) {
      out.add(t.mention.page.id);
    }
    const href: string | undefined = t.href ?? t.text?.link?.url;
    if (href && /notion\.(so|site|com)/.test(href)) {
      const id = notionId(href.split("?")[0]);
      if (id) out.add(id);
    }
  }
}

export function blockText(block: Json): string {
  const type = block.type;
  if (TEXT_TYPES.includes(type)) return plain(block[type]?.rich_text);
  if (type === "child_page") return `[하위 페이지] ${block.child_page?.title ?? ""}`;
  if (type === "child_database") return `[데이터베이스] ${block.child_database?.title ?? ""}`;
  if (type === "bookmark" || type === "link_preview" || type === "embed") return block[type]?.url ?? "";
  if (type === "table_row") return (block.table_row?.cells ?? []).map((c: Json[]) => plain(c)).join(" | ");
  return "";
}

// 블록 목록을 모델에게 줄 글로 바꿉니다. stopAtResult이면 '실행 결과' 제목 앞까지만 읽습니다
// (요청 행 본문에 이전 실행 결과가 덧붙어 있어도 지시서만 읽기 위해서).
export function blocksToText(blocks: Json[], stopAtResult = false): PageText {
  const lines: string[] = [];
  const refs = new Set<string>();
  let skippedNested = 0;
  for (const b of blocks) {
    const t = blockText(b);
    if (stopAtResult && /^heading_/.test(b.type) && t.startsWith(RESULT_HEADING)) break;
    if (b.type === "child_page") refs.add(b.id);
    const type = b.type;
    if (TEXT_TYPES.includes(type)) refsFromRichText(b[type]?.rich_text, refs);
    if (b.has_children && b.type !== "child_page" && b.type !== "child_database") skippedNested++;
    if (!t) continue;
    const prefix =
      type === "heading_1" ? "# " :
      type === "heading_2" ? "## " :
      type === "heading_3" ? "### " :
      type === "bulleted_list_item" ? "- " :
      type === "numbered_list_item" ? "1. " :
      type === "to_do" ? (b.to_do?.checked ? "- [x] " : "- [ ] ") :
      type === "quote" ? "> " : "";
    lines.push(prefix + t);
  }
  return { text: lines.join("\n"), refs: [...refs], skippedNested };
}

// 노션 표는 행이 안쪽 블록이라 따로 읽어야 합니다. 호출 한도를 지키려고 표 3개까지만 펼칩니다.
export async function expandTables(notion: Notion, blocks: Json[], maxTables = 3): Promise<Json[]> {
  const out: Json[] = [];
  let expanded = 0;
  for (const b of blocks) {
    if (b.type === "table" && b.has_children && expanded < maxTables && notion.callsLeft() > 12) {
      expanded++;
      const rows = await notion.listChildren(b.id, 1);
      out.push({ ...b, has_children: false }, ...rows.blocks);
      continue;
    }
    out.push(b);
  }
  return out;
}

// ---------- 결과(마크다운) → 노션 블록 ----------

type Annot = { bold?: boolean; code?: boolean };

function run(content: string, annotations: Annot = {}, link?: string): Json[] {
  const runs: Json[] = [];
  for (let i = 0; i < content.length; i += 2000) {
    const piece = content.slice(i, i + 2000);
    const r: Json = { type: "text", text: link ? { content: piece, link: { url: link } } : { content: piece } };
    if (annotations.bold || annotations.code) r.annotations = { bold: !!annotations.bold, code: !!annotations.code };
    runs.push(r);
  }
  return runs;
}

// 굵게(**…**), 코드(`…`), 링크([글](https://…))만 노션 서식으로 옮기고 나머지는 글 그대로 둡니다.
export function inlineRuns(text: string): Json[] {
  const out: Json[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(...run(text.slice(last, m.index)));
    if (m[1] !== undefined) out.push(...run(m[1], { bold: true }));
    else if (m[2] !== undefined) out.push(...run(m[2], { code: true }));
    else out.push(...run(m[3], {}, m[4]));
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(...run(text.slice(last)));
  return out.slice(0, 100);
}

function textBlock(type: string, content: string, extra: Json = {}): Json {
  return { object: "block", type, [type]: { rich_text: inlineRuns(content), ...extra } };
}

export function linkParagraph(label: string, url: string): Json {
  return { object: "block", type: "paragraph", paragraph: { rich_text: [...run(label), ...run(url, {}, url)] } };
}

export function divider(): Json {
  return { object: "block", type: "divider", divider: {} };
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function tableBlock(rows: string[][]): Json {
  const width = Math.max(1, Math.min(20, ...rows.map((r) => r.length)));
  return {
    object: "block",
    type: "table",
    table: {
      table_width: width,
      has_column_header: true,
      has_row_header: false,
      children: rows.slice(0, 99).map((r) => ({
        object: "block",
        type: "table_row",
        table_row: { cells: Array.from({ length: width }, (_, i) => inlineRuns(r[i] ?? "")) },
      })),
    },
  };
}

// 간단한 마크다운을 노션 블록으로 바꿉니다(제목·목록·표·인용·코드·구분선).
export function markdownToBlocks(md: string): Json[] {
  const blocks: Json[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.trim().match(/^(`{3,})/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      const code = body.join("\n") || " ";
      blocks.push({ object: "block", type: "code", code: { rich_text: run(code), language: "plain text" } });
      continue;
    }
    // 표: | a | b | 다음 줄이 |---|---|
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const rows = [splitRow(line)];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(splitRow(lines[i++]));
      blocks.push(tableBlock(rows));
      continue;
    }
    i++;
    const s = line.trim();
    if (!s) continue;
    let m: RegExpMatchArray | null;
    if ((m = s.match(/^#{1,2}\s+(.*)$/))) blocks.push(textBlock("heading_2", m[1]));
    else if ((m = s.match(/^#{3,6}\s+(.*)$/))) blocks.push(textBlock("heading_3", m[1]));
    else if ((m = s.match(/^[-*+]\s+\[( |x)\]\s+(.*)$/i)))
      blocks.push(textBlock("to_do", m[2], { checked: m[1].toLowerCase() === "x" }));
    else if ((m = s.match(/^[-*+]\s+(.*)$/))) blocks.push(textBlock("bulleted_list_item", m[1]));
    else if ((m = s.match(/^\d+[.)]\s+(.*)$/))) blocks.push(textBlock("numbered_list_item", m[1]));
    else if ((m = s.match(/^>\s?(.*)$/))) blocks.push(textBlock("quote", m[1]));
    else if (/^(-{3,}|\*{3,}|_{3,})$/.test(s)) blocks.push(divider());
    else blocks.push(textBlock("paragraph", s));
  }
  return blocks;
}

// 저장 확인용: 보낸 블록과 다시 읽은 블록의 글을 같은 방식으로 이어 붙여 비교합니다.
// withRows이면 보낸 표의 행을 펼쳐서, 다시 읽은 쪽을 expandTables로 펼친 상태와 맞춥니다.
// withRows가 아니면 표의 행은 양쪽 모두 빼고 비교합니다.
export function blocksFingerprint(blocks: Json[], withRows = true): string {
  const flat: Json[] = [];
  for (const b of blocks) {
    if (b.type === "table_row" && !withRows) continue;
    flat.push(b);
    if (withRows && b.type === "table" && Array.isArray(b.table?.children)) flat.push(...b.table.children);
  }
  return flat
    .map((b) => (b.type === "divider" ? "---" : blockText(b)))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

export function tableCount(blocks: Json[]): number {
  return blocks.filter((b) => b.type === "table").length;
}

