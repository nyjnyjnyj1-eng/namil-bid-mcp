import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { DeskAPI } from "../src/index";
import { drain, FakeWorld, makeEnv, REC_DS, REQ_DS } from "./fake";

afterEach(() => vi.unstubAllGlobals());

const PASS = "correct-horse-battery-staple";
const call = (env: any, path: string, init: RequestInit & { pass?: string | null } = {}) => {
  const headers = new Headers(init.headers);
  if (init.pass !== null) headers.set("x-desk-passcode", init.pass ?? PASS);
  if (init.body) headers.set("Content-Type", "application/json");
  return worker.fetch(new Request(`https://desk.test${path}`, { ...init, headers }), env);
};

describe("화면과 공개 주소", () => {
  it("첫 화면은 암호 없이 열리고, 외부 자원을 쓰지 않도록 보안 헤더를 붙인다", async () => {
    const env = makeEnv(new FakeWorld());
    const res = await call(env, "/", { pass: null });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>AI 작업실</title>");
    expect(html).toContain('id="btnSend"');
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(html).not.toMatch(/<script[^>]+src=/);
  });

  it("홈 화면용 설정과 아이콘을 내려준다", async () => {
    const env = makeEnv(new FakeWorld());
    const m = await call(env, "/manifest.webmanifest", { pass: null });
    expect(JSON.parse(await m.text()).name).toBe("AI 작업실");
    const svg = await call(env, "/icon.svg", { pass: null });
    expect(svg.headers.get("Content-Type")).toBe("image/svg+xml");
    const png = new Uint8Array(await (await call(env, "/apple-touch-icon.png", { pass: null })).arrayBuffer());
    expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("상태 점검 주소는 비밀값을 보여 주지 않는다", async () => {
    const env = makeEnv(new FakeWorld());
    const text = await (await call(env, "/health", { pass: null })).text();
    expect(text).not.toContain("cb_test_key");
    expect(text).not.toContain("secret_notion_test");
    expect(text).not.toContain(PASS);
    expect(JSON.parse(text).secrets.CORAL_API_KEY).toBe(true);
  });
});

describe("입력창 API", () => {
  it("암호가 없거나 틀리면 아무것도 하지 않는다", async () => {
    const world = new FakeWorld();
    world.install();
    const env = makeEnv(world);
    expect((await call(env, "/api/jobs", { pass: null })).status).toBe(401);
    expect((await call(env, "/api/jobs", { method: "POST", body: JSON.stringify({ text: "x" }), pass: "wrong" })).status).toBe(401);
    expect(world.calls).toHaveLength(0);
  });

  it("실행기 암호가 16자보다 짧게 설정돼 있으면 입력창을 막는다", async () => {
    const env = makeEnv(new FakeWorld(), { WEB_PASSCODE: "short" });
    expect((await call(env, "/api/jobs", { pass: "short" })).status).toBe(401);
  });

  it("붙여넣다 딸려 온 공백이 있어도 암호를 받아들인다", async () => {
    const env = makeEnv(new FakeWorld(), { WEB_PASSCODE: `  ${PASS}\n` });
    expect((await call(env, "/api/jobs", { pass: ` ${PASS} ` })).status).toBe(200);
  });

  it("보내기 → 작업 보기 → 최근 목록이 이어진다", async () => {
    const world = new FakeWorld({ ai: ["답입니다"] });
    world.install();
    const env = makeEnv(world, { CORAL_API_KEY: undefined, HIVE_API_KEY: undefined });
    const res = await call(env, "/api/jobs", { method: "POST", body: JSON.stringify({ text: "첫 줄 제목\n본문" }) });
    expect(res.status).toBe(200);
    const { job } = (await res.json()) as any;
    expect(job.id).toMatch(/^web-/);
    expect(job.title).toBe("첫 줄 제목");
    expect(job.status).toBe("실행 중");
    await drain(env);
    const view = (await (await call(env, `/api/jobs/${job.id}`)).json()) as any;
    expect(view.job.status).toBe("완료");
    expect(view.job.resultMarkdown).toBe("답입니다");
    const list = (await (await call(env, "/api/jobs")).json()) as any;
    expect(list.jobs[0].id).toBe(job.id);
    expect(list.features).toEqual({ notion: true, hiveCheck: false });
    expect(list.autoOrder).toEqual(["coral", "hive", "free"]);
    expect(list.health.free.ok).toBe(true);
  });

  it("잘못된 요청은 이유와 함께 거절한다", async () => {
    const env = makeEnv(new FakeWorld(), { NOTION_TOKEN: undefined });
    const empty = await call(env, "/api/jobs", { method: "POST", body: JSON.stringify({ text: "  " }) });
    expect(empty.status).toBe(400);
    const save = await call(env, "/api/jobs", { method: "POST", body: JSON.stringify({ text: "x", save: true }) });
    expect(((await save.json()) as any).error).toContain("노션 연결");
    const check = await call(env, "/api/jobs", { method: "POST", body: JSON.stringify({ text: "x", worker: "hive-check" }) });
    expect(((await check.json()) as any).error).toContain("Hive 검사");
    expect((await call(env, "/api/jobs/not-a-job")).status).toBe(404);
    expect((await call(env, "/api/jobs", { method: "POST", body: "{" })).status).toBe(400);
  });

  it("연결 점검: 모델별 상태와 실행기가 읽을 수 있는 노션 페이지를 보여 준다", async () => {
    const world = new FakeWorld({
      coral: [{ status: 403, body: "card_required" }],
      hiveSse: { status: 401, body: "Invalid or expired token" },
      ai: ["ok"],
    });
    world.addPage({ title: "입찰 연구 노트" });
    world.addPage({ ds: REQ_DS, title: "요청함 행" });
    world.addPage({ ds: REC_DS, title: "기록 행" });
    world.install();
    const env = makeEnv(world);
    const d = (await (await call(env, "/api/check")).json()) as any;
    expect(d.coral).toMatchObject({ ok: false, reason: "계정에 카드 등록이 필요합니다" });
    expect(d.hive).toMatchObject({ ok: false, reason: "키가 맞지 않거나 만료되었습니다" });
    expect(d.free.ok).toBe(true);
    expect(d.notion.pages).toEqual(["입찰 연구 노트"]);
    expect(world.aiCalls[0].input.max_tokens).toBe(2);
  });
});

describe("다른 Worker가 쓰는 내부 입구", () => {
  it("암호 없이 작업을 맡기고 결과를 볼 수 있다(같은 계정의 서비스 바인딩 전용)", async () => {
    const world = new FakeWorld({ ai: ["내부 입구 답"] });
    world.install();
    const env = makeEnv(world, { CORAL_API_KEY: undefined, HIVE_API_KEY: undefined });
    const api = new DeskAPI({} as any, env);
    const r = await api.submit({ text: "입찰 서버가 맡긴 일" });
    if (!r.ok) throw new Error(r.error);
    await drain(env);
    expect((await api.view(r.job.id))!.resultMarkdown).toBe("내부 입구 답");
    expect((await api.list()).jobs).toHaveLength(1);
  });
});
