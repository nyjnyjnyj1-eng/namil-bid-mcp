import { Json, plain, textRuns } from "./notion";

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

function textBlock(type: string, content: string, extra: Json = {}): Json {
  return { object: "block", type, [type]: { rich_text: textRuns(content), ...extra } };
}

export function linkParagraph(label: string, url: string): Json {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [...textRuns(label), ...textRuns(url, url)] },
  };
}

export function divider(): Json {
  return { object: "block", type: "divider", divider: {} };
}

// 간단한 마크다운을 노션 블록으로 바꿉니다. 굵게 표시 등 글자 꾸밈은 떼고 글만 남깁니다.
export function markdownToBlocks(md: string): Json[] {
  const blocks: Json[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^(`{3,})/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(fence[1])) body.push(lines[i++]);
      i++;
      blocks.push(textBlock("code", body.join("\n") || " ", { language: "plain text" }));
      continue;
    }
    i++;
    const s = line.trim();
    if (!s) continue;
    const clean = (x: string) => x.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1");
    let m: RegExpMatchArray | null;
    if ((m = s.match(/^#{1,2}\s+(.*)$/))) blocks.push(textBlock("heading_2", clean(m[1])));
    else if ((m = s.match(/^#{3,6}\s+(.*)$/))) blocks.push(textBlock("heading_3", clean(m[1])));
    else if ((m = s.match(/^[-*+]\s+\[( |x)\]\s+(.*)$/i)))
      blocks.push(textBlock("to_do", clean(m[2]), { checked: m[1].toLowerCase() === "x" }));
    else if ((m = s.match(/^[-*+]\s+(.*)$/))) blocks.push(textBlock("bulleted_list_item", clean(m[1])));
    else if ((m = s.match(/^\d+[.)]\s+(.*)$/))) blocks.push(textBlock("numbered_list_item", clean(m[1])));
    else if ((m = s.match(/^>\s?(.*)$/))) blocks.push(textBlock("quote", clean(m[1])));
    else if (/^(-{3,}|\*{3,})$/.test(s)) blocks.push(divider());
    else blocks.push(textBlock("paragraph", clean(s)));
  }
  return blocks;
}

// 저장 확인용: 보낸 블록과 다시 읽은 블록의 글을 같은 방식으로 이어 붙여 비교합니다.
export function blocksFingerprint(blocks: Json[]): string {
  return blocks
    .map((b) => (b.type === "divider" ? "---" : blockText(b)))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}
