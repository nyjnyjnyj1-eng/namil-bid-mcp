import { describe, expect, it } from "vitest";
import { blocksFingerprint, blocksToText, markdownToBlocks, notionId } from "../src/blocks";
import { parseSse } from "../src/llm";
import { parseModelOutput } from "../src/protocol";

describe("모델 응답 읽기", () => {
  it("코드 블록으로 감싼 JSON도 읽는다", () => {
    const a = parseModelOutput('```json\n{"action":"final","결과":"요약","근거":"하나"}\n```');
    expect(a.action).toBe("final");
    if (a.action === "final") expect(a.answer.evidence).toEqual(["하나"]);
  });
  it("영어 키도 받아들인다", () => {
    const a = parseModelOutput('{"result":"ok","limits":["x"]}');
    expect(a.action).toBe("final");
  });
  it("결과가 없으면 형식 오류로 본다", () => {
    expect(parseModelOutput("그냥 글").action).toBe("invalid");
    expect(parseModelOutput('{"action":"final"}').action).toBe("invalid");
  });
  it("검색·읽기 요청을 구분한다", () => {
    expect(parseModelOutput('{"action":"search","query":"공고"}')).toEqual({ action: "search", query: "공고" });
    expect(parseModelOutput('{"action":"read","page_id":"abc"}')).toEqual({ action: "read", pageId: "abc" });
  });
});

describe("스트리밍 응답", () => {
  it("조각을 이어 붙이고 사용량을 읽는다", () => {
    const s =
      'data: {"choices":[{"delta":{"content":"안"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"녕"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n' +
      "data: [DONE]\n\n";
    expect(parseSse(s)).toEqual({ text: "안녕", usage: { input: 5, output: 2 } });
  });
});

describe("노션 블록", () => {
  it("노션 주소에서 ID를 뽑는다", () => {
    expect(notionId("https://www.notion.so/My-Page-0123456789abcdef0123456789abcdef?pvs=4")).toBe(
      "01234567-89ab-cdef-0123-456789abcdef",
    );
    expect(notionId("없음")).toBeNull();
  });
  it("마크다운을 블록으로 바꾸고 2000자 넘는 글은 나눠 담는다", () => {
    const long = "가".repeat(4500);
    const blocks = markdownToBlocks(`## 제목\n- 항목\n1. 번호\n> 인용\n**굵게** 본문\n${long}\n\`\`\`\ncode\n\`\`\``);
    expect(blocks.map((b) => b.type)).toEqual(["heading_2", "bulleted_list_item", "numbered_list_item", "quote", "paragraph", "paragraph", "code"]);
    expect(blocks[4].paragraph.rich_text[0].text.content).toBe("굵게 본문");
    expect(blocks[5].paragraph.rich_text).toHaveLength(3);
  });
  it("'실행 결과' 제목 앞까지만 지시서로 읽는다", () => {
    const blocks = markdownToBlocks("지시서 본문\n## 실행 결과 · 2026\n이전 결과");
    expect(blocksToText(blocks, true).text).toBe("지시서 본문");
  });
  it("저장 확인용 비교는 공백 차이를 무시한다", () => {
    const a = markdownToBlocks("가  나\n다");
    const b = markdownToBlocks("가 나\n\n다");
    expect(blocksFingerprint(a)).toBe(blocksFingerprint(b));
  });
});
