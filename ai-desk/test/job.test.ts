import { afterEach, describe, expect, it, vi } from "vitest";
import { submitJob } from "../src/index";
import { rowJobId, sweep } from "../src/intake";
import { SIMPLE_PROMPT } from "../src/protocol";
import { aiError, board, drain, FakeWorld, final, makeEnv, mention, para, REC_DS, REQ_DS, runner, table, TestEnv } from "./fake";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function webJob(env: TestEnv, body: Record<string, unknown>) {
  const r = await submitJob(env, body as any);
  if (!r.ok) throw new Error(r.error);
  await drain(env);
  return (await runner(env, r.job.id).view())!;
}

function queued(world: FakeWorld, title: string, body: any[], props: Record<string, any> = {}) {
  return world.addPage({ ds: REQ_DS, title, body, props: { 상태: { select: { name: "대기" } }, ...props } });
}

const coralCalls = (w: FakeWorld) => w.calls.filter((c) => c.url.startsWith("https://coral.test"));
const hiveCalls = (w: FakeWorld) => w.calls.filter((c) => c.url.startsWith("https://hive.test"));

describe("웹에서 빠른 질문", () => {
  it("노션에 아무것도 쓰지 않고, 키가 없는 모델은 건너뛰어 무료 모델로 답한다", async () => {
    const world = new FakeWorld({ ai: ["적격심사는 낙찰자를 정하기 위한 심사입니다."] });
    world.install();
    const env = makeEnv(world, { CORAL_API_KEY: undefined, HIVE_API_KEY: undefined });
    const job = await webJob(env, { text: "적격심사가 뭐야?" });

    expect(job.status).toBe("완료");
    expect(job.provider).toContain("무료 모델");
    expect(job.resultMarkdown).toBe("적격심사는 낙찰자를 정하기 위한 심사입니다.");
    expect(job.skipped.join(" ")).toContain("Coral: 키가 설정되지 않았습니다");
    expect(job.skipped.join(" ")).toContain("Hive: 키가 설정되지 않았습니다");
    expect(world.notionCalls()).toHaveLength(0);
    expect(world.aiCalls[0].model).toBe("@cf/google/gemma-test");
    expect(world.aiCalls[0].input.messages[0].content).toBe(SIMPLE_PROMPT);
    expect(world.aiCalls[0].input.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("자동 모드: Coral 카드 미등록·Hive 키 오류면 이유를 남기고 무료 모델로 넘어간다", async () => {
    const world = new FakeWorld({
      coral: [{ status: 403, body: '{"error":{"reason":"card_required","message":"provide a card"}}' }],
      hiveSse: { status: 401, body: '{"status_code":401,"message":"Invalid or expired token"}' },
      ai: ["답"],
    });
    world.install();
    const env = makeEnv(world);
    const job = await webJob(env, { text: "질문" });
    expect(job.status).toBe("완료");
    expect(job.skipped).toEqual(["Coral: 계정에 카드 등록이 필요합니다", "Hive: 키가 맞지 않거나 만료되었습니다"]);
    const health = await board(env).health();
    expect(health.coral?.ok).toBe(false);
    expect(health.hive?.ok).toBe(false);
    expect(health.free?.ok).toBe(true);
  });

  it("막힌 것으로 확인된 모델은 30분 동안 다시 부르지 않는다", async () => {
    const world = new FakeWorld({ coral: [{ status: 403, body: "card required" }], hiveSse: { status: 401, body: "bad" }, ai: ["1", "2"] });
    world.install();
    const env = makeEnv(world);
    await webJob(env, { text: "첫 질문" });
    const before = coralCalls(world).length + hiveCalls(world).length;
    const second = await webJob(env, { text: "두 번째 질문" });
    expect(second.status).toBe("완료");
    expect(coralCalls(world).length + hiveCalls(world).length).toBe(before);
    expect(second.skipped.join(" ")).toContain("Coral");
  });

  it("Coral이 되면 Coral로 답하고 무료 모델은 부르지 않는다", async () => {
    const world = new FakeWorld({ coral: ["Coral의 답"] });
    world.install();
    const env = makeEnv(world);
    const job = await webJob(env, { text: "질문" });
    expect(job.provider).toBe("Coral (coral-default)");
    expect(job.resultMarkdown).toBe("Coral의 답");
    expect(world.aiCalls).toHaveLength(0);
    expect(coralCalls(world)[0].headers.authorization).toBe("Bearer cb_test_key");
  });

  it("직접 고른 모델이 막히면 다른 모델로 넘어가지 않고 이유와 함께 실패로 알린다", async () => {
    const world = new FakeWorld({ coral: [{ status: 403, body: '{"reason":"card_required"}' }] });
    world.install();
    const env = makeEnv(world);
    const job = await webJob(env, { text: "질문", worker: "coral" });
    expect(job.status).toBe("실패");
    expect(job.error).toContain("카드 등록");
    expect(world.aiCalls).toHaveLength(0);
  });

  it("같은 작업을 두 번 시작해도 한 번만 처리한다", async () => {
    const world = new FakeWorld({ ai: ["한 번"] });
    world.install();
    const env = makeEnv(world, { CORAL_API_KEY: undefined, HIVE_API_KEY: undefined });
    const r = await submitJob(env, { text: "질문" });
    if (!r.ok) throw new Error(r.error);
    const again = await runner(env, r.job.id).start({ source: "web", title: "x", text: "질문", worker: "auto", notionSearch: false, save: false, rounds: 3 }, r.job.id);
    expect(again.id).toBe(r.job.id);
    await drain(env);
    expect(world.aiCalls).toHaveLength(1);
  });
});

describe("웹 + 노션", () => {
  it("노션에 저장: 작업 기록에 요청과 결과를 남기고 다시 읽어 확인한다", async () => {
    const world = new FakeWorld({ ai: [final("**정리 결과**와 [공고](https://www.g2b.go.kr)")] });
    world.install();
    const env = makeEnv(world, { CORAL_API_KEY: undefined, HIVE_API_KEY: undefined });
    const job = await webJob(env, { text: "이번 공고 조건 정리", save: true });

    expect(job.status).toBe("완료");
    const recs = world.pagesIn(REC_DS);
    expect(recs).toHaveLength(1);
    const rec = recs[0];
    expect(job.recordUrl).toBe(rec.url);
    expect(rec.properties["출처"].select.name).toBe("웹");
    expect(rec.properties["작업자"].select.name).toBe("무료 모델");
    expect(rec.properties["검토"].select.name).toBe("미검토");
    const text = world.text(rec.id);
    expect(text).toContain("이번 공고 조건 정리");
    expect(text).toContain("새 결과");
    expect(text).toContain("근거");
    expect(text).toContain("다음 할 일");
    // 굵게·링크는 노션 서식으로
    const blocks = world.children.get(rec.id)!;
    const runs = blocks.flatMap((b) => b[b.type]?.rich_text ?? []);
    expect(runs.some((r: any) => r.annotations?.bold && r.plain_text === "정리 결과")).toBe(true);
    expect(runs.some((r: any) => r.text?.link?.url === "https://www.g2b.go.kr")).toBe(true);
    // 요청함에는 아무것도 만들지 않음
    expect(world.pagesIn(REQ_DS)).toHaveLength(0);
  });

  it("결과의 마크다운 표는 노션 표로 저장하고, 행까지 다시 읽어 확인한다", async () => {
    const md = "| 항목 | 값 |\n|---|---|\n| 업종 | 건축공사업 |\n| 지역 | 경기 |";
    const world = new FakeWorld({ ai: [final(md)] });
    world.install();
    const env = makeEnv(world, { CORAL_API_KEY: undefined, HIVE_API_KEY: undefined });
    const job = await webJob(env, { text: "표로 정리", save: true });
    expect(job.status).toBe("완료");
    const rec = world.pagesIn(REC_DS)[0];
    const tbl = world.children.get(rec.id)!.find((b) => b.type === "table")!;
    expect(tbl.table.table_width).toBe(2);
    expect(world.text(rec.id)).toContain("업종 | 건축공사업");
  });

  it("다시 읽은 기록이 보낸 내용과 다르면 '저장 확인 실패'로 알린다", async () => {
    const world = new FakeWorld({ ai: [final("결과")], corruptRecordWrites: true });
    world.install();
    const env = makeEnv(world, { CORAL_API_KEY: undefined, HIVE_API_KEY: undefined });
    const job = await webJob(env, { text: "저장", save: true });
    expect(job.status).toBe("저장 확인 실패");
  });

  it("요청 글에 붙인 노션 링크를 읽어 자료로 넘긴다(표 내용 포함)", async () => {
    const world = new FakeWorld({ ai: ["링크 내용 요약"] });
    const ref = world.addPage({ title: "○○ 입찰 연구", body: [para("미해결 문제: 지역 제한"), table([["항목", "값"], ["하한율", "87.745%"]])] });
    world.install();
    const env = makeEnv(world, { CORAL_API_KEY: undefined, HIVE_API_KEY: undefined });
    const job = await webJob(env, { text: `이거 요약해줘 https://www.notion.so/Bid-${ref.id.replace(/-/g, "")}?pvs=4` });
    expect(job.status).toBe("완료");
    const sent = world.aiCalls[0].input.messages[1].content as string;
    expect(sent).toContain("미해결 문제: 지역 제한");
    expect(sent).toContain("하한율 | 87.745%");
    expect(sent).toContain("[자료: ○○ 입찰 연구");
  });

  it("읽을 수 없는 노션 링크는 이유를 남기고 계속한다", async () => {
    const world = new FakeWorld({ ai: ["답"] });
    world.install();
    const env = makeEnv(world, { CORAL_API_KEY: undefined, HIVE_API_KEY: undefined });
    const job = await webJob(env, { text: "https://www.notion.so/0123456789abcdef0123456789abcdef 요약" });
    expect(job.status).toBe("완료");
    expect(job.resultMarkdown).toContain("실행기 연결이 그 페이지에 추가되지 않았을 수 있습니다");
  });

  it("노션에서 찾기: 검색 → 읽기 → 최종 답을 단계마다 따로 실행한다", async () => {
    const world = new FakeWorld();
    const found = world.addPage({ title: "작년 공사 분석", body: [para("낙찰률 87.7%")] });
    world.addPage({ ds: REQ_DS, title: "작년 공사 분석 다시", body: [], props: { 상태: { select: { name: "완료" } } } });
    world.aiQueue.push(
      JSON.stringify({ action: "search", query: "작년 공사 분석" }),
      JSON.stringify({ action: "read", page_id: found.id }),
      final("낙찰률은 87.7%로 기록되어 있습니다."),
    );
    world.install();
    const env = makeEnv(world, { CORAL_API_KEY: undefined, HIVE_API_KEY: undefined });
    const job = await webJob(env, { text: "작년 공사 분석을 찾아 정리해", notionSearch: true, rounds: 3 });

    expect(job.status).toBe("완료");
    expect(world.aiCalls).toHaveLength(3);
    const searchReply = world.aiCalls[1].input.messages.at(-1).content as string;
    expect(searchReply).toContain(found.id);
    expect(searchReply).not.toContain("작년 공사 분석 다시"); // 요청함 행은 검색 결과에서 뺌
    expect(world.aiCalls[2].input.messages.at(-1).content).toContain("낙찰률 87.7%");
    expect(job.resultMarkdown).toContain("노션에서 찾기: 2회 / 최대 3회");
  });

  it("노션에서 찾기 한도를 넘기면 더 찾지 않고 최종 답을 요구한다", async () => {
    const world = new FakeWorld({
      ai: [JSON.stringify({ action: "search", query: "a" }), JSON.stringify({ action: "search", query: "b" }), final("정리")],
    });
    world.install();
    const env = makeEnv(world, { CORAL_API_KEY: undefined, HIVE_API_KEY: undefined });
    const job = await webJob(env, { text: "찾아봐", notionSearch: true, rounds: 1 });
    expect(job.status).toBe("완료");
    expect(world.calls.filter((c) => c.url.endsWith("/v1/search"))).toHaveLength(1);
    expect(world.aiCalls[2].input.messages.at(-1).content).toContain("더 이상 자료를 요청할 수 없습니다");
    expect(job.resultMarkdown).toContain("한도(1회)를 모두 썼습니다");
  });

  it("형식이 틀린 답이 계속되면 원문을 남기고 그 사실을 한계에 적는다", async () => {
    const world = new FakeWorld({ ai: ["그냥 글", "또 그냥 글"] });
    world.install();
    const env = makeEnv(world, { CORAL_API_KEY: undefined, HIVE_API_KEY: undefined });
    const job = await webJob(env, { text: "정리", save: true });
    expect(job.status).toBe("완료");
    expect(job.resultMarkdown).toContain("또 그냥 글");
    expect(job.resultMarkdown).toContain("JSON");
  });
});

describe("노션 요청함 (Claude·직접 입력)", () => {
  it("1분 점검이 '대기' 행을 가져가 처리하고, 결과를 행 아래에 붙인 뒤 상태를 바꾼다", async () => {
    const world = new FakeWorld({ ai: [final("공고 3건 중 2건이 조건에 맞습니다.")] });
    const ref = world.addPage({ title: "○○ 입찰 연구", body: [para("미해결 문제: 지역 제한 해석")] });
    const row = queued(world, "입찰 검토", [para("[할 일] 정리"), mention("[참고] ", ref.id)], { 요청자: { select: { name: "Claude" } } });
    world.install();
    const env = makeEnv(world, { CORAL_API_KEY: undefined, HIVE_API_KEY: undefined });

    const log = await sweep(env);
    expect(log).toContain("시작: 입찰 검토");
    expect(world.prop(row.id, "상태")).toBe("실행 중");
    await drain(env);

    expect(world.prop(row.id, "상태")).toBe("완료");
    expect(world.prop(row.id, "처리 모델")).toBe("무료 모델 (gemma-test)");
    const text = world.text(row.id);
    expect(text).toContain("[할 일] 정리"); // 기존 지시서는 그대로
    expect(text).toContain("실행 결과 ·");
    expect(text).toContain("공고 3건 중 2건이 조건에 맞습니다.");
    expect(world.aiCalls[0].input.messages[1].content).toContain("미해결 문제: 지역 제한 해석");
    // 웹 목록에도 보인다
    const recent = await board(env).list();
    expect(recent[0].id).toBe(rowJobId(row.id));
    expect(recent[0].source).toBe("notion");
  });

  it("노션 기록을 켜면 작업 기록 페이지를 만들고(요청과 연결) 행에는 링크를 남긴다", async () => {
    const world = new FakeWorld({ ai: [final("기록할 결과")] });
    const row = queued(world, "기록 요청", [para("중요한 조사")], { "노션 기록": { checkbox: true } });
    world.install();
    const env = makeEnv(world, { CORAL_API_KEY: undefined, HIVE_API_KEY: undefined });
    await sweep(env);
    await drain(env);
    const rec = world.pagesIn(REC_DS)[0];
    expect(rec.properties["요청"].relation).toEqual([{ id: row.id }]);
    expect(rec.properties["출처"].select.name).toBe("요청함");
    expect(world.text(rec.id)).toContain("중요한 조사");
    expect(world.prop(row.id, "결과 페이지")).toBe(rec.url);
    expect(world.text(row.id)).toContain(rec.url);
    expect(world.prop(row.id, "상태")).toBe("완료");
  });

  it("기존 블록을 고치거나 지우는 호출을 하지 않는다", async () => {
    const world = new FakeWorld({ ai: [final("결과")] });
    queued(world, "가벼운 요청", [para("요약해줘")]);
    world.install();
    const env = makeEnv(world, { CORAL_API_KEY: undefined, HIVE_API_KEY: undefined });
    await sweep(env);
    await drain(env);
    const calls = world.notionCalls();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    for (const c of calls.filter((c) => c.method === "PATCH")) {
      expect(/\/v1\/pages\/[^/]+$|\/children$/.test(new URL(c.url).pathname)).toBe(true);
    }
  });

  it("다시 '대기'로 바꾸면 이전 결과가 아니라 지시서만 읽어 다시 처리한다", async () => {
    const world = new FakeWorld({ ai: [final("첫 결과"), final("둘째 결과")] });
    const row = queued(world, "재실행", [para("원래 지시서")]);
    world.install();
    const env = makeEnv(world, { CORAL_API_KEY: undefined, HIVE_API_KEY: undefined });
    await sweep(env);
    await drain(env);
    world.pages.get(row.id)!.properties["상태"] = { type: "select", select: { name: "대기" } };
    await sweep(env);
    await drain(env);
    const second = world.aiCalls[1].input.messages[1].content as string;
    expect(second).toContain("원래 지시서");
    expect(second).not.toContain("첫 결과");
    expect(world.text(row.id)).toContain("둘째 결과");
  });

  it("지시서가 비어 있으면 실패로 안내한다", async () => {
    const world = new FakeWorld();
    const row = queued(world, "빈 요청", []);
    world.install();
    const env = makeEnv(world);
    await sweep(env);
    await drain(env);
    expect(world.prop(row.id, "상태")).toBe("실패");
    expect(world.prop(row.id, "오류")).toContain("비어 있습니다");
  });

  it("이전 이름 '자체조사'와 'Hive LLM'도 알아듣는다", async () => {
    const world = new FakeWorld({ hiveSse: 'data: {"choices":[{"delta":{"content":"{\\"결과\\":\\"하이브\\"}"}}]}\n\ndata: [DONE]\n\n' });
    const row = queued(world, "옛 형식", [para("정리")], { 자체조사: { checkbox: true }, 작업자: { select: { name: "Hive LLM" } } });
    world.install();
    const env = makeEnv(world);
    await sweep(env);
    await drain(env);
    expect(world.prop(row.id, "상태")).toBe("완료");
    expect(hiveCalls(world)[0].body.stream).toBe(true);
    expect(world.text(row.id)).toContain("하이브");
  });
});

describe("문제가 생겼을 때", () => {
  it("일시적인 오류(무료 모델 혼잡)는 잠시 뒤 다시 시도해 끝낸다", async () => {
    const world = new FakeWorld({ ai: [aiError("3040: Capacity temporarily exceeded"), aiError("3040"), "결국 성공"] });
    world.install();
    const env = makeEnv(world);
    const job = await webJob(env, { text: "질문", worker: "free" });
    expect(job.status).toBe("완료");
    expect(job.resultMarkdown).toBe("결국 성공");
    expect(world.aiCalls).toHaveLength(3);
  });

  it("무료 사용량을 다 쓰면 기다리지 않고 이유를 알려 준다", async () => {
    const world = new FakeWorld({ ai: [aiError("3036: You have used up your daily free allocation of 10,000 neurons.")] });
    world.install();
    const env = makeEnv(world, { CORAL_API_KEY: undefined, HIVE_API_KEY: undefined });
    const job = await webJob(env, { text: "질문" });
    expect(job.status).toBe("실패");
    expect(job.error).toContain("오늘 무료 사용량을 다 썼습니다");
    expect(world.aiCalls).toHaveLength(1);
  });

  it("일시적인 오류가 계속되면 3번 다시 해 본 뒤 실패로 끝내고 노션 행에도 남긴다", async () => {
    const world = new FakeWorld({ ai: [aiError("3040"), aiError("3040"), aiError("3040"), aiError("3040")] });
    const row = queued(world, "계속 실패", [para("정리")], { 작업자: { select: { name: "무료 모델" } } });
    world.install();
    const env = makeEnv(world);
    await sweep(env);
    await drain(env);
    expect(world.aiCalls).toHaveLength(4);
    expect(world.prop(row.id, "상태")).toBe("실패");
    expect(world.prop(row.id, "오류")).toContain("혼잡");
  });

  it("기록 페이지를 만든 뒤 확인 단계에서 끊겨도, 다시 할 때 기록을 두 번 만들지 않는다", async () => {
    const world = new FakeWorld({ ai: [final("결과")] });
    world.install();
    const env = makeEnv(world, { CORAL_API_KEY: undefined, HIVE_API_KEY: undefined });
    const r = await submitJob(env, { text: "저장", save: true });
    if (!r.ok) throw new Error(r.error);
    // 기록 페이지가 만들어진 직후의 확인 요청을 한 번 실패시킴
    const origHandle = world.handle.bind(world);
    let failed = false;
    world.handle = async (input: string, init: RequestInit) => {
      if (!failed && (init.method ?? "GET") === "GET" && /\/v1\/blocks\/.*\/children/.test(input) && world.pagesIn(REC_DS).length === 1) {
        failed = true;
        return new Response('{"object":"error"}', { status: 502 });
      }
      return origHandle(input, init);
    };
    world.install();
    await drain(env);
    const job = (await runner(env, r.job.id).view())!;
    expect(failed).toBe(true);
    expect(job.status).toBe("완료");
    expect(world.pagesIn(REC_DS)).toHaveLength(1);
  });

  it("멈춘 작업은 1분 점검이 다시 깨워 끝낸다", async () => {
    const world = new FakeWorld({ ai: ["재개 성공"] });
    world.install();
    const env = makeEnv(world, { CORAL_API_KEY: undefined, HIVE_API_KEY: undefined });
    const r = await submitJob(env, { text: "질문" });
    if (!r.ok) throw new Error(r.error);
    // 알람이 사라진 상황을 흉내 냄
    (runner(env, r.job.id) as any).ctx.storage.alarm = null;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 25 * 60_000);
    const log = await sweep(env);
    expect(log).toContain("재개(resumed)");
    await drain(env);
    expect((await runner(env, r.job.id).view())!.status).toBe("완료");
  });

  it("실행 정보가 사라진 요청 행은 다시 대기로 돌리고, 3번째에는 실패로 남긴다", async () => {
    const world = new FakeWorld();
    const row = queued(world, "사라짐", [para("정리")], {
      상태: { select: { name: "실행 중" } },
      "내부 상태": { rich_text: [{ type: "text", text: { content: JSON.stringify({ job: "row-x", at: 0, attempts: 1 }) } }] },
    });
    world.install();
    const env = makeEnv(world);
    expect(await sweep(env)).toContain("다시 대기");
    expect(world.prop(row.id, "상태")).toBe("대기");
    world.pages.get(row.id)!.properties["상태"] = { type: "select", select: { name: "실행 중" } };
    world.pages.get(row.id)!.properties["내부 상태"] = { type: "rich_text", rich_text: [{ plain_text: JSON.stringify({ job: "row-x", at: 0, attempts: 3 }) }] };
    expect(await sweep(env)).toContain("실패 처리");
    expect(world.prop(row.id, "상태")).toBe("실패");
  });

  it("끝난 작업의 실행 정보는 30일 뒤 지운다", async () => {
    const world = new FakeWorld({ ai: ["답"] });
    world.install();
    const env = makeEnv(world, { CORAL_API_KEY: undefined, HIVE_API_KEY: undefined });
    const job = await webJob(env, { text: "질문" });
    const inst: any = runner(env, job.id);
    expect(inst.ctx.storage.alarm).toBeGreaterThan(Date.now() + 29 * 24 * 3600_000);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(inst.ctx.storage.alarm + 1000);
    await inst.alarm();
    expect(await inst.view()).toBeNull();
  });
});

describe("Hive", () => {
  it("Hive는 스트리밍 응답을 이어 붙여 처리한다", async () => {
    const sse =
      ["안녕", "하세요"].map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join("") + "data: [DONE]\n\n";
    const world = new FakeWorld({ hiveSse: sse });
    world.install();
    const env = makeEnv(world);
    const job = await webJob(env, { text: "인사", worker: "hive" });
    expect(job.resultMarkdown).toBe("안녕하세요");
    const call = hiveCalls(world)[0];
    expect(call.url).toBe("https://hive.test/api/v3/chat/completions");
    expect(call.body.stream).toBe(true);
    expect(call.headers.authorization).toBe("Bearer hive_test_key");
  });

  it("Hive 검사는 설정된 틀에 글을 넣어 보내고 응답 원문을 남긴다", async () => {
    const world = new FakeWorld({ hiveCheck: '{"score":0.91}' });
    world.install();
    const env = makeEnv(world, { HIVE_CHECK_URL: "https://hive.test/check", HIVE_CHECK_BODY: '{"input":[{"text":"{{TEXT}}"}]}' });
    const job = await webJob(env, { text: '따옴표 "포함" 글', worker: "hive-check" });
    expect(job.status).toBe("완료");
    const call = world.calls.find((c) => c.url === "https://hive.test/check")!;
    expect(call.body.input[0].text).toBe('따옴표 "포함" 글');
    expect(job.resultMarkdown).toContain('"score": 0.91');
  });
});

describe("호출 한도", () => {
  it("단계마다 외부 호출은 50회를 넘지 않는다", async () => {
    const world = new FakeWorld();
    const refs = Array.from({ length: 4 }, (_, i) => world.addPage({ title: `자료${i}`, body: [para("내용"), table([["a", "b"], ["1", "2"]])] }));
    const row = queued(world, "많은 호출", [para("정리"), ...refs.map((r) => mention("참고 ", r.id))], {
      "노션에서 찾기": { checkbox: true },
      "최대 조사 횟수": { number: 5 },
      "노션 기록": { checkbox: true },
    });
    for (let i = 0; i < 5; i++) world.aiQueue.push(JSON.stringify({ action: "read", page_id: refs[i % 4].id }));
    world.aiQueue.push(final("끝"));
    world.install();
    const env = makeEnv(world, { CORAL_API_KEY: undefined, HIVE_API_KEY: undefined });
    await sweep(env);
    // 단계 하나씩 실행하며 그 단계의 외부 호출 수를 잽니다.
    const inst: any = runner(env, rowJobId(row.id));
    let steps = 0;
    while (inst.ctx.storage.alarm !== null && inst.ctx.storage.alarm < Date.now() + 120_000 && steps < 50) {
      const before = world.calls.length;
      inst.ctx.storage.alarm = null;
      await inst.alarm();
      expect(world.calls.length - before).toBeLessThanOrEqual(50);
      steps++;
    }
    expect(world.prop(row.id, "상태")).toBe("완료");
  });
});
