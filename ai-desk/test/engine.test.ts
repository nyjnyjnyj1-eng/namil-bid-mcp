import { afterEach, describe, expect, it, vi } from "vitest";
import { tick } from "../src/engine";
import worker from "../src/index";
import { FakeWorld, final, makeEnv, mention, para, REC_DS, REQ_DS, table } from "./fake";

afterEach(() => vi.unstubAllGlobals());

function queued(world: FakeWorld, title: string, body: any[], props: Record<string, any> = {}) {
  return world.addPage({
    ds: REQ_DS,
    title,
    body,
    props: { 상태: { select: { name: "대기" } }, ...props },
  });
}

const coralCalls = (w: FakeWorld) => w.calls.filter((c) => c.url.startsWith("https://coral.test"));

describe("1단계: 지시서에 적힌 자료만 읽고 처리", () => {
  it("참고 페이지를 읽어 모델에 넘기고, 결과를 요청 행 아래에 덧붙인 뒤 완료로 바꾼다", async () => {
    const world = new FakeWorld({ coral: [final("공고 3건 중 2건이 조건에 맞습니다.")] });
    const ref = world.addPage({ title: "○○ 입찰 연구", body: [para("미해결 문제: 지역 제한 해석")] });
    const row = queued(world, "입찰 검토", [para("[할 일] 정리"), mention("[참고] ", ref.id)]);
    world.install();

    const report = await tick(makeEnv());

    expect(report).toContain("완료");
    expect(world.prop(row.id, "상태")).toBe("완료");
    const sent = coralCalls(world)[0].body;
    expect(sent.model).toBe("coral-default");
    expect(sent.messages[1].content).toContain("미해결 문제: 지역 제한 해석");
    const text = world.text(row.id);
    expect(text).toContain("[할 일] 정리"); // 기존 지시서는 그대로
    expect(text).toContain("실행 결과 ·");
    expect(text).toContain("공고 3건 중 2건이 조건에 맞습니다.");
    expect(text).toContain("자체조사: 사용 안 함");
    // 비밀키는 해당 서비스로만 간다
    expect(coralCalls(world)[0].headers.authorization).toBe("Bearer cb_test_key");
    const notionAuth = world.calls.filter((c) => c.url.startsWith("https://api.notion.com")).map((c) => c.headers.authorization);
    expect(new Set(notionAuth)).toEqual(new Set(["Bearer secret_notion_test"]));
  });

  it("참고 페이지와 지시서 안의 표 내용도 읽는다", async () => {
    const world = new FakeWorld({ coral: [final("표 요약")] });
    const ref = world.addPage({ title: "상태 표", body: [para("상태의 뜻"), table([["상태", "뜻"], ["대기", "실행 차례를 기다림"]])] });
    queued(world, "표 읽기", [para("[할 일] 요약"), table([["조건", "값"], ["지역", "경기"]]), mention("[참고] ", ref.id)]);
    world.install();
    await tick(makeEnv());
    const sent = coralCalls(world)[0].body.messages[1].content as string;
    expect(sent).toContain("대기 | 실행 차례를 기다림");
    expect(sent).toContain("지역 | 경기");
    expect(sent).not.toContain("안쪽 내용은 읽지 않았습니다");
  });

  it("기존 블록을 고치거나 지우는 호출을 하지 않는다", async () => {
    const world = new FakeWorld({ coral: [final("결과")] });
    queued(world, "가벼운 요청", [para("요약해줘")]);
    world.install();
    await tick(makeEnv());
    const notionCalls = world.calls.filter((c) => c.url.startsWith("https://api.notion.com"));
    expect(notionCalls.some((c) => c.method === "DELETE")).toBe(false);
    // PATCH는 페이지 속성 변경과 /children 덧붙이기만 허용
    for (const c of notionCalls.filter((c) => c.method === "PATCH")) {
      expect(/\/v1\/pages\/[^/]+$|\/children$/.test(new URL(c.url).pathname)).toBe(true);
    }
  });

  it("다시 실행하면 이전 결과가 아니라 지시서만 읽는다", async () => {
    const world = new FakeWorld({ coral: [final("첫 결과"), final("둘째 결과")] });
    const row = queued(world, "재실행", [para("원래 지시서")]);
    world.install();
    await tick(makeEnv());
    world.pages.get(row.id)!.properties["상태"] = { type: "select", select: { name: "대기" } };
    await tick(makeEnv());
    const second = coralCalls(world)[1].body.messages[1].content as string;
    expect(second).toContain("원래 지시서");
    expect(second).not.toContain("첫 결과");
    expect(world.text(row.id)).toContain("둘째 결과");
  });
});

describe("2단계: 노션 안에서 스스로 찾아 읽기", () => {
  it("검색→읽기→최종 답 순서로 진행하고, 요청함 행은 검색 결과에서 뺀다", async () => {
    const world = new FakeWorld();
    const found = world.addPage({ title: "작년 공사 분석", body: [para("낙찰률 87.7%")] });
    queued(world, "작년 공사 분석 이어가기", [para("작년 공사 분석을 참고해 정리")], {
      자체조사: { checkbox: true },
      "최대 조사 횟수": { number: 3 },
    });
    world.coralQueue.push(
      JSON.stringify({ action: "search", query: "작년 공사 분석" }),
      JSON.stringify({ action: "read", page_id: found.id }),
      final("낙찰률은 87.7%로 기록되어 있습니다."),
    );
    world.install();

    await tick(makeEnv());

    const calls = coralCalls(world);
    expect(calls).toHaveLength(3);
    const searchReply = calls[1].body.messages.at(-1).content as string;
    expect(searchReply).toContain(found.id);
    expect(searchReply).not.toContain("작년 공사 분석 이어가기"); // 요청함 행 제외
    expect(calls[2].body.messages.at(-1).content).toContain("낙찰률 87.7%");
    const rows = [...world.pages.values()].filter((p) => p.parent?.data_source_id === REQ_DS);
    const text = world.text(rows[0].id);
    expect(text).toContain("자체조사: 2회 사용 / 최대 3회");
  });

  it("조사 횟수를 넘기면 더 찾지 않고 최종 답을 요구한다", async () => {
    const world = new FakeWorld();
    queued(world, "한도 시험", [para("계속 찾아봐")], { 자체조사: { checkbox: true }, "최대 조사 횟수": { number: 1 } });
    world.coralQueue.push(
      JSON.stringify({ action: "search", query: "a" }),
      JSON.stringify({ action: "search", query: "b" }),
      final("지금까지 자료로 정리"),
    );
    world.install();
    await tick(makeEnv());
    const searches = world.calls.filter((c) => c.url === "https://api.notion.com/v1/search");
    expect(searches).toHaveLength(1);
    expect(coralCalls(world)[2].body.messages.at(-1).content).toContain("더 이상 자료를 요청할 수 없습니다");
  });

  it("자체조사를 켜지 않으면 검색 요청을 들어주지 않는다", async () => {
    const world = new FakeWorld({ coral: [JSON.stringify({ action: "search", query: "x" }), final("정리")] });
    queued(world, "1단계", [para("정리")]);
    world.install();
    await tick(makeEnv());
    expect(world.calls.some((c) => c.url.endsWith("/v1/search"))).toBe(false);
  });
});

describe("노션 기록과 저장 확인", () => {
  it("노션 기록을 켜면 작업 기록에 새 페이지를 만들고 요청 행에는 링크를 남긴다", async () => {
    const world = new FakeWorld({ coral: [final("기록할 결과")] });
    const row = queued(world, "기록 요청", [para("중요한 조사")], { "노션 기록": { checkbox: true } });
    world.install();
    await tick(makeEnv());
    const records = [...world.pages.values()].filter((p) => p.parent?.data_source_id === REC_DS);
    expect(records).toHaveLength(1);
    const rec = records[0];
    expect(rec.properties["요청"].relation).toEqual([{ id: row.id }]);
    expect(rec.properties["검토"].select.name).toBe("미검토");
    expect(world.text(rec.id)).toContain("중요한 조사");
    expect(world.text(rec.id)).toContain("기록할 결과");
    expect(world.prop(row.id, "결과 페이지")).toBe(rec.url);
    expect(world.text(row.id)).toContain(rec.url);
    expect(world.prop(row.id, "상태")).toBe("완료");
  });

  it("다시 읽은 기록이 보낸 내용과 다르면 '저장 확인 실패'로 표시한다", async () => {
    const world = new FakeWorld({ coral: [final("결과")], corruptRecordWrites: true });
    const row = queued(world, "확인 실패", [para("조사")], { "노션 기록": { checkbox: true } });
    world.install();
    await tick(makeEnv());
    expect(world.prop(row.id, "상태")).toBe("저장 확인 실패");
    expect(world.prop(row.id, "오류")).toContain("보낸 내용과 다릅니다");
  });
});

describe("실패 처리", () => {
  it("모델 API 오류는 실패로 표시하고 오류 내용을 남긴다", async () => {
    const world = new FakeWorld({ coral: [{ status: 401, body: '{"error":"invalid api key"}' }] });
    const row = queued(world, "오류", [para("정리")]);
    world.install();
    await tick(makeEnv());
    expect(world.prop(row.id, "상태")).toBe("실패");
    const err = world.prop(row.id, "오류") as string;
    expect(err).toContain("Coral API 오류 (401)");
    expect(err).not.toContain("cb_test_key");
  });

  it("지시서가 비어 있으면 실패로 안내한다", async () => {
    const world = new FakeWorld();
    const row = queued(world, "빈 요청", []);
    world.install();
    await tick(makeEnv());
    expect(world.prop(row.id, "오류")).toContain("지시서 본문이 비어 있습니다");
  });

  it("형식이 맞지 않는 답이 계속되면 원문을 그대로 남기고 그 사실을 한계에 적는다", async () => {
    const world = new FakeWorld({ coral: ["그냥 글로 답함", "또 글로 답함"] });
    const row = queued(world, "형식", [para("정리")]);
    world.install();
    await tick(makeEnv());
    const text = world.text(row.id);
    expect(text).toContain("또 글로 답함");
    expect(text).toContain("JSON");
    expect(world.prop(row.id, "상태")).toBe("완료");
  });

  it("중간에 멈춘 작업은 다시 가져가되, 3회 넘게 멈추면 실패로 남긴다", async () => {
    const world = new FakeWorld({ coral: [final("재개 성공")] });
    const expired = new Date(Date.now() - 60_000).toISOString();
    const stuck = queued(world, "멈춤", [para("정리")], {
      상태: { select: { name: "실행 중" } },
      "내부 상태": { rich_text: [{ type: "text", text: { content: JSON.stringify({ token: "old", lease_until: expired, attempts: 1 }) } }] },
    });
    world.install();
    await tick(makeEnv());
    expect(world.prop(stuck.id, "상태")).toBe("완료");

    const world2 = new FakeWorld();
    const dead = queued(world2, "계속 멈춤", [para("정리")], {
      상태: { select: { name: "실행 중" } },
      "내부 상태": { rich_text: [{ type: "text", text: { content: JSON.stringify({ token: "old", lease_until: expired, attempts: 3 }) } }] },
    });
    world2.install();
    await tick(makeEnv());
    expect(world2.prop(dead.id, "상태")).toBe("실패");
    expect(coralCalls(world2)).toHaveLength(0);
  });

  it("아직 실행 중인 작업(lease 유효)은 건드리지 않는다", async () => {
    const world = new FakeWorld();
    const future = new Date(Date.now() + 600_000).toISOString();
    queued(world, "진행 중", [para("정리")], {
      상태: { select: { name: "실행 중" } },
      "내부 상태": { rich_text: [{ type: "text", text: { content: JSON.stringify({ token: "x", lease_until: future, attempts: 1 }) } }] },
    });
    world.install();
    expect(await tick(makeEnv())).toBe("대기 중인 요청 없음");
  });

  it("외부 호출은 실행 1회당 50회를 넘지 않는다", async () => {
    const world = new FakeWorld();
    const refs = Array.from({ length: 4 }, (_, i) => world.addPage({ title: `자료${i}`, body: [para("내용")] }));
    queued(world, "많은 호출", [para("정리"), ...refs.map((r) => mention("참고 ", r.id))], {
      자체조사: { checkbox: true },
      "최대 조사 횟수": { number: 5 },
    });
    for (let i = 0; i < 5; i++) world.coralQueue.push(JSON.stringify({ action: "read", page_id: refs[i % 4].id }));
    world.coralQueue.push(final("끝"));
    world.install();
    await tick(makeEnv());
    expect(world.calls.length).toBeLessThanOrEqual(50);
  });
});

describe("Hive", () => {
  it("Hive LLM은 스트리밍 응답을 이어 붙여 처리한다", async () => {
    const answer = final("Hive 결과");
    const half = Math.floor(answer.length / 2);
    const sse = [answer.slice(0, half), answer.slice(half)]
      .map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`)
      .join("") + "data: [DONE]\n\n";
    const world = new FakeWorld({ hiveSse: sse });
    const row = queued(world, "하이브", [para("정리")], { 작업자: { select: { name: "Hive LLM" } } });
    world.install();
    await tick(makeEnv());
    const call = world.calls.find((c) => c.url.startsWith("https://hive.test"))!;
    expect(call.body.stream).toBe(true);
    expect(call.body.model).toBe("hive-default");
    expect(world.text(row.id)).toContain("Hive 결과");
  });

  it("Hive 검사는 설정이 비어 있으면 실패로 안내한다", async () => {
    const world = new FakeWorld();
    const row = queued(world, "검사", [para("검사할 글")], { 작업자: { select: { name: "Hive 검사" } } });
    world.install();
    await tick(makeEnv());
    expect(world.prop(row.id, "오류")).toContain("HIVE_CHECK_URL");
  });

  it("Hive 검사는 설정된 틀에 글을 넣어 보내고 응답 원문을 남긴다", async () => {
    const world = new FakeWorld({ hiveCheck: '{"score":0.91}' });
    const row = queued(world, "검사", [para('따옴표 "포함" 글')], { 작업자: { select: { name: "Hive 검사" } } });
    world.install();
    await tick(makeEnv({ HIVE_CHECK_URL: "https://hive.test/check", HIVE_CHECK_BODY: '{"input":[{"text":"{{TEXT}}"}]}' }));
    const call = world.calls.find((c) => c.url === "https://hive.test/check")!;
    expect(call.body.input[0].text).toBe('따옴표 "포함" 글');
    expect(world.text(row.id)).toContain('"score": 0.91');
  });
});

describe("입력창", () => {
  const post = (body: unknown, pass = "correct-horse-battery-staple") =>
    new Request("https://desk.test/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-desk-passcode": pass },
      body: JSON.stringify(body),
    });

  it("암호가 틀리면 아무것도 만들지 않는다", async () => {
    const world = new FakeWorld();
    world.install();
    const res = await worker.fetch(post({ instruction: "x" }, "wrong"), makeEnv());
    expect(res.status).toBe(401);
    expect(world.calls).toHaveLength(0);
  });

  it("암호가 16자보다 짧게 설정돼 있으면 입력창을 막는다", async () => {
    const world = new FakeWorld();
    world.install();
    const res = await worker.fetch(post({ instruction: "x" }, "short"), makeEnv({ WEB_PASSCODE: "short" }));
    expect(res.status).toBe(401);
  });

  it("지금 실행: 요청 행을 만들고 바로 처리해 결과를 돌려준다", async () => {
    const world = new FakeWorld({ coral: [final("바로 받은 결과")] });
    world.install();
    const res = await worker.fetch(post({ instruction: "이 문단 요약해줘", worker: "Coral" }), makeEnv());
    const data: any = await res.json();
    expect(data.ok).toBe(true);
    expect(data.status).toBe("완료");
    expect(data.resultMarkdown).toContain("바로 받은 결과");
    const row = [...world.pages.values()].find((p) => p.parent?.data_source_id === REQ_DS)!;
    expect(world.prop(row.id, "요청자")).toBe("입력창");
    expect(world.text(row.id)).toContain("이 문단 요약해줘");
  });

  it("요청함에만 넣기: 대기 상태로 만들고 모델은 부르지 않는다", async () => {
    const world = new FakeWorld();
    world.install();
    const res = await worker.fetch(post({ instruction: "나중에", queueOnly: true }), makeEnv());
    const data: any = await res.json();
    expect(data.status).toBe("대기");
    expect(coralCalls(world)).toHaveLength(0);
  });

  it("상태 점검 주소는 비밀값을 보여 주지 않는다", async () => {
    const res = await worker.fetch(new Request("https://desk.test/health"), makeEnv());
    const text = await res.text();
    expect(text).not.toContain("cb_test_key");
    expect(text).not.toContain("secret_notion_test");
    expect(text).not.toContain("correct-horse");
    expect(JSON.parse(text).secrets.CORAL_API_KEY).toBe(true);
  });
});
