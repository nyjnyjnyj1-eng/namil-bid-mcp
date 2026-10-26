import { describe, expect, it } from "vitest";
import { blocksFingerprint, blocksToText, inlineRuns, markdownToBlocks, notionId, notionRefsFromText } from "../src/blocks";
import { newState, renderResult } from "../src/job";
import { parseModelOutput } from "../src/protocol";
import { contentOf, parseSse, workerFromName } from "../src/providers";
import { cleanEnv, kst, passcodeOk } from "../src/util";

describe("모델 응답 읽기", () => {
  it("코드 블록으로 감싼 JSON도 읽는다", () => {
    const a = parseModelOutput('```json\n{"action":"final","결과":"요약","근거":"하나"}\n```');
    expect(a.action).toBe("final");
    if (a.action === "final") expect(a.answer.evidence).toEqual(["하나"]);
  });
  it("영어 키도 받아들이고, 결과가 없으면 형식 오류로 본다", () => {
    expect(parseModelOutput('{"result":"ok","limits":["x"]}').action).toBe("final");
    expect(parseModelOutput("그냥 글").action).toBe("invalid");
    expect(parseModelOutput('{"action":"final"}').action).toBe("invalid");
  });
  it("검색·읽기 요청을 구분한다", () => {
    expect(parseModelOutput('{"action":"search","query":"공고"}')).toEqual({ action: "search", query: "공고" });
    expect(parseModelOutput('{"action":"read","page_id":"abc"}')).toEqual({ action: "read", pageId: "abc" });
  });
  it("여러 응답 모양에서 답 글을 꺼낸다", () => {
    expect(contentOf({ choices: [{ message: { content: "a" } }] })).toBe("a");
    expect(contentOf({ response: "b" })).toBe("b");
    expect(contentOf({ output: [{ content: [{ text: "c" }] }] })).toBe("c");
    expect(contentOf({})).toBe("");
  });
  it("스트리밍 조각을 이어 붙이고 사용량을 읽는다", () => {
    const s =
      'data: {"choices":[{"delta":{"content":"안"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"녕"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n' +
      "data: [DONE]\n\n";
    expect(parseSse(s)).toEqual({ text: "안녕", usage: { input: 5, output: 2 } });
  });
  it("노션의 작업자 이름을 알아듣는다(옛 이름 포함)", () => {
    expect(workerFromName("Hive LLM")).toBe("hive");
    expect(workerFromName("무료 모델")).toBe("free");
    expect(workerFromName(undefined)).toBe("auto");
    expect(workerFromName("자동")).toBe("auto");
  });
});

describe("노션 블록", () => {
  it("노션 주소에서 ID를 뽑는다", () => {
    expect(notionId("https://www.notion.so/My-Page-0123456789abcdef0123456789abcdef?pvs=4")).toBe(
      "01234567-89ab-cdef-0123-456789abcdef",
    );
    expect(notionId("없음")).toBeNull();
  });
  it("글 속의 노션 링크만 골라낸다", () => {
    const ids = notionRefsFromText(
      "참고: https://app.notion.com/p/4004a300643981469011d946e03f18f0?pvs=204 그리고 https://example.com/0123456789abcdef0123456789abcdef",
    );
    expect(ids).toEqual(["4004a300-6439-8146-9011-d946e03f18f0"]);
  });
  it("마크다운을 블록으로 바꾸고 2000자 넘는 글은 나눠 담는다", () => {
    const long = "가".repeat(4500);
    const blocks = markdownToBlocks(`## 제목\n- 항목\n1. 번호\n> 인용\n**굵게** 본문\n${long}\n\`\`\`\ncode\n\`\`\``);
    expect(blocks.map((b) => b.type)).toEqual(["heading_2", "bulleted_list_item", "numbered_list_item", "quote", "paragraph", "paragraph", "code"]);
    expect(blocks[4].paragraph.rich_text[0]).toMatchObject({ text: { content: "굵게" }, annotations: { bold: true } });
    expect(blocks[5].paragraph.rich_text).toHaveLength(3);
  });
  it("마크다운 표를 노션 표로 바꾼다", () => {
    const [t] = markdownToBlocks("| 항목 | 값 |\n|:--|--:|\n| 업종 | **건축** |");
    expect(t.type).toBe("table");
    expect(t.table.table_width).toBe(2);
    expect(t.table.children).toHaveLength(2);
    expect(t.table.children[1].table_row.cells[1][0]).toMatchObject({ text: { content: "건축" }, annotations: { bold: true } });
  });
  it("링크와 코드도 노션 서식으로 옮긴다", () => {
    const runs = inlineRuns("앞 [공고](https://g2b.go.kr) 뒤 `코드`");
    expect(runs.map((r) => r.text.content)).toEqual(["앞 ", "공고", " 뒤 ", "코드"]);
    expect(runs[1].text.link.url).toBe("https://g2b.go.kr");
    expect(runs[3].annotations.code).toBe(true);
  });
  it("'실행 결과' 제목 앞까지만 지시서로 읽는다", () => {
    const blocks = markdownToBlocks("지시서 본문\n## 실행 결과 · 2026\n이전 결과");
    expect(blocksToText(blocks, true).text).toBe("지시서 본문");
  });
  it("저장 확인용 비교는 공백 차이를 무시하고, 표 행을 빼고도 비교할 수 있다", () => {
    expect(blocksFingerprint(markdownToBlocks("가  나\n다"))).toBe(blocksFingerprint(markdownToBlocks("가 나\n\n다")));
    const sent = markdownToBlocks("| a | b |\n|---|---|\n| 1 | 2 |");
    const readBack = [{ type: "table", table: {}, has_children: true }];
    expect(blocksFingerprint(readBack, false)).toBe(blocksFingerprint(sent, false));
  });
});

describe("결과 정리", () => {
  it("정리 모드는 새 결과·근거·한계·다음 할 일·사용한 자료·실행 정보를 나눠 쓴다", () => {
    const s = newState("web-1", { source: "web", title: "t", text: "x", worker: "auto", notionSearch: false, save: true, rounds: 3 });
    s.answer = { result: "본문", evidence: ["근거1"], limits: [], nextSteps: ["할 일"], sources: [] };
    s.provider = "free";
    s.model = "@cf/google/gemma-4-26b-a4b-it";
    s.skipped = ["Coral: 계정에 카드 등록이 필요합니다"];
    s.notes = ["메모", "메모"];
    s.answeredAt = Date.UTC(2026, 9, 26, 5, 3);
    const md = renderResult(s);
    for (const h of ["### 새 결과", "### 근거", "### 한계", "### 다음 할 일", "### 사용한 자료", "### 실행 정보"]) expect(md).toContain(h);
    expect(md).toContain("- 메모");
    expect(md.match(/- 메모/g)).toHaveLength(1);
    expect(md).toContain("처리: 무료 모델 (gemma-4-26b-a4b-it)");
    expect(md).toContain("건너뜀: Coral: 계정에 카드 등록이 필요합니다");
    expect(md).toContain("2026-10-26 14:03 (한국 시간)");
  });
  it("간단 모드는 답만 보여 주고 참고 사항은 끝에 붙인다", () => {
    const s = newState("web-2", { source: "web", title: "t", text: "x", worker: "auto", notionSearch: false, save: false, rounds: 3 });
    s.answerText = "답";
    s.notes = ["링크를 읽지 못했습니다"];
    expect(renderResult(s)).toBe("답\n\n> 참고: 링크를 읽지 못했습니다");
  });
});

describe("도구", () => {
  it("한국 시간으로 표시한다(Intl 없이)", () => {
    expect(kst(Date.UTC(2026, 9, 25, 15, 30))).toBe("2026-10-26 00:30");
  });
  it("비밀값의 앞뒤 공백을 떼되 바인딩은 그대로 둔다", () => {
    const AI = { run() {} };
    const e = cleanEnv({ HIVE_API_KEY: "  hive_key\n", NOTION_TOKEN: "\tntn_x ", AI } as any);
    expect(e.HIVE_API_KEY).toBe("hive_key");
    expect(e.NOTION_TOKEN).toBe("ntn_x");
    expect(e.AI).toBe(AI);
  });
  it("암호는 16자 이상일 때만, 정확히 같을 때만 통과한다", async () => {
    expect(await passcodeOk("correct-horse-battery", "correct-horse-battery")).toBe(true);
    expect(await passcodeOk("correct-horse-battery", "correct-horse-batter")).toBe(false);
    expect(await passcodeOk("short", "short")).toBe(false);
    expect(await passcodeOk(undefined, "x")).toBe(false);
  });
});
