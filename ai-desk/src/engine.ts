import { blocksFingerprint, blocksToText, divider, linkParagraph, markdownToBlocks, notionId, RESULT_HEADING } from "./blocks";
import { Budget, BudgetError } from "./budget";
import { Env, LIMITS } from "./env";
import { chat, ChatMessage, hiveCheck, Usage, Worker } from "./llm";
import { Json, Notion, pageTitle, plain, prop } from "./notion";
import { fallbackAnswer, FinalAnswer, parseModelOutput, systemPrompt } from "./protocol";

export const STATUS = {
  waiting: "대기",
  running: "실행 중",
  done: "완료",
  failed: "실패",
  verifyFailed: "저장 확인 실패",
} as const;

export interface Lease {
  token: string;
  lease_until: string;
  attempts: number;
}

export interface JobSettings {
  title: string;
  worker: Worker;
  selfResearch: boolean;
  rounds: number;
  record: boolean;
  model: string;
}

export interface JobOutcome {
  status: string;
  rowUrl: string;
  recordUrl?: string;
  resultMarkdown?: string;
  error?: string;
}

interface Material {
  title: string;
  id: string;
  text: string;
}

const MAX_ATTEMPTS = 3;

const kst = (d = new Date()) =>
  new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);

function propValue(page: Json, name: string): Json | undefined {
  return page.properties?.[name];
}

export function readSettings(env: Env, page: Json): JobSettings {
  const workerName = propValue(page, "작업자")?.select?.name;
  const worker: Worker = workerName === "Hive LLM" || workerName === "Hive 검사" ? workerName : "Coral";
  const rawRounds = Number(propValue(page, "최대 조사 횟수")?.number ?? LIMITS.defaultRounds);
  const rounds = Math.max(1, Math.min(LIMITS.maxRounds, Number.isFinite(rawRounds) ? Math.floor(rawRounds) : LIMITS.defaultRounds));
  const modelOverride = plain(propValue(page, "모델")?.rich_text).trim();
  return {
    title: pageTitle(page),
    worker,
    selfResearch: Boolean(propValue(page, "자체조사")?.checkbox),
    rounds,
    record: Boolean(propValue(page, "노션 기록")?.checkbox),
    model: modelOverride || (worker === "Hive LLM" ? env.HIVE_MODEL : env.CORAL_MODEL),
  };
}

export function readLease(page: Json): Lease | null {
  const raw = plain(propValue(page, "내부 상태")?.rich_text);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return typeof v === "object" && v ? v : null;
  } catch {
    return null;
  }
}

export function newLease(previous: Lease | null): Lease {
  return {
    token: crypto.randomUUID(),
    lease_until: new Date(Date.now() + LIMITS.leaseMinutes * 60_000).toISOString(),
    attempts: (previous?.attempts ?? 0) + 1,
  };
}

function isClaimable(page: Json): boolean {
  const status = propValue(page, "상태")?.select?.name;
  if (status === STATUS.waiting) return true;
  if (status !== STATUS.running) return false;
  const lease = readLease(page);
  return !lease || Date.parse(lease.lease_until) < Date.now();
}

// 1분마다 실행: 가장 오래된 대기 요청 1건을 가져가 처리합니다.
export async function tick(env: Env): Promise<string> {
  if (!env.NOTION_TOKEN) return "NOTION_TOKEN 미설정";
  const budget = new Budget(LIMITS.subrequests);
  const notion = new Notion(env.NOTION_TOKEN, budget);
  const list = await notion.queryDataSource(env.NOTION_REQUESTS_DS_ID, {
    filter: {
      or: [
        { property: "상태", select: { equals: STATUS.waiting } },
        { property: "상태", select: { equals: STATUS.running } },
      ],
    },
    sorts: [{ timestamp: "created_time", direction: "ascending" }],
    page_size: 25,
  });
  const target = (list.results ?? []).find(isClaimable);
  if (!target) return "대기 중인 요청 없음";

  const previous = readLease(target);
  if (propValue(target, "상태")?.select?.name === STATUS.running && (previous?.attempts ?? 0) >= MAX_ATTEMPTS) {
    // 같은 요청이 여러 번 중간에 멈췄다면 계속 다시 돌리지 않고 실패로 남깁니다.
    await notion.updatePage(target.id, {
      상태: prop.select(STATUS.failed),
      오류: prop.text(`${MAX_ATTEMPTS}회 시도했지만 끝까지 실행되지 않았습니다. 지시서를 줄이거나 자체조사 횟수를 낮춰 다시 '대기'로 바꿔 주세요.`),
    });
    return `${pageTitle(target)}: 반복 중단으로 실패 처리`;
  }
  // '대기'에서 새로 시작하면 시도 횟수를 다시 셉니다.
  const isRetryOfStall = propValue(target, "상태")?.select?.name === STATUS.running;
  const lease = newLease(isRetryOfStall ? previous : null);
  await notion.updatePage(target.id, {
    상태: prop.select(STATUS.running),
    "내부 상태": prop.text(JSON.stringify(lease)),
    오류: prop.text(""),
  });
  // 다른 실행과 동시에 가져갔는지 다시 읽어 확인합니다.
  const fresh = await notion.getPage(target.id);
  if (readLease(fresh)?.token !== lease.token) return "다른 실행이 가져감";

  const outcome = await runJob(env, notion, budget, fresh, lease);
  return `${pageTitle(fresh)}: ${outcome.status}${outcome.error ? ` (${outcome.error})` : ""}`;
}

export async function runJob(env: Env, notion: Notion, budget: Budget, row: Json, lease: Lease): Promise<JobOutcome> {
  const settings = readSettings(env, row);
  const rowUrl: string = row.url ?? "";
  try {
    const body = await notion.listChildren(row.id, 2);
    const instruction = blocksToText(body.blocks, true);
    if (!instruction.text.trim()) throw new Error("지시서 본문이 비어 있습니다. 요청 행의 본문에 지시서를 써 주세요.");

    const notes: string[] = [];
    if (body.truncated) notes.push("지시서가 길어 앞부분 200블록만 읽었습니다.");
    if (instruction.skippedNested) notes.push(`지시서의 토글·중첩 블록 ${instruction.skippedNested}개 안쪽 내용은 읽지 않았습니다.`);

    let answer: FinalAnswer;
    let usage: Usage = { input: 0, output: 0 };
    let researchUsed = 0;

    if (settings.worker === "Hive 검사") {
      const raw = await hiveCheck(env, budget, instruction.text);
      let pretty = raw;
      try {
        pretty = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {}
      answer = {
        result: "Hive 검사 응답 원문입니다.\n\n```\n" + pretty.slice(0, 12000) + "\n```",
        evidence: [],
        limits: ["Hive 응답을 해석하지 않고 원문 그대로 남겼습니다. 점수의 의미는 Hive 문서로 확인하세요."],
        nextSteps: [],
        sources: [],
      };
      if (pretty.length > 12000) answer.limits.push("응답이 길어 앞부분 12,000자만 남겼습니다.");
    } else {
      const materials = await readReferences(notion, budget, instruction.refs, notes);
      const r = await converse(env, notion, budget, settings, instruction.text, materials, notes);
      answer = r.answer;
      usage = r.usage;
      researchUsed = r.researchUsed;
    }

    answer.limits.push(...notes);
    const resultMd = renderResult(settings, answer, usage, researchUsed);
    return await writeResult(env, notion, row, settings, instruction.text, resultMd, lease);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // 실패 표시는 따로 잡아 둔 호출 3회로 합니다(본 작업이 호출 한도를 다 썼어도 남길 수 있게).
    await safeFail(new Notion(env.NOTION_TOKEN ?? "", new Budget(3)), row.id, message, lease);
    return { status: STATUS.failed, rowUrl, error: message };
  }
}

async function readPageText(notion: Notion, id: string): Promise<Material> {
  const page = await notion.getPage(id);
  const children = await notion.listChildren(id, 1);
  const t = blocksToText(children.blocks);
  let text = t.text;
  if (children.truncated) text += "\n(이후 내용은 길어서 생략됨)";
  return { title: pageTitle(page), id, text: text.slice(0, LIMITS.perPageChars) };
}

async function readReferences(notion: Notion, budget: Budget, refs: string[], notes: string[]): Promise<Material[]> {
  const out: Material[] = [];
  for (const id of refs.slice(0, LIMITS.maxRefs)) {
    if (budget.remaining() < LIMITS.writeReserve + 4) {
      notes.push("호출 한도 때문에 일부 참고 페이지를 읽지 못했습니다.");
      break;
    }
    try {
      out.push(await readPageText(notion, id));
    } catch (e) {
      if (e instanceof BudgetError) throw e;
      notes.push(`참고 페이지(${id})를 읽지 못했습니다. 실행기 연결이 그 페이지에 공유되지 않았을 수 있습니다.`);
    }
  }
  if (refs.length > LIMITS.maxRefs) notes.push(`참고 페이지가 많아 앞의 ${LIMITS.maxRefs}개만 읽었습니다.`);
  return out;
}

function materialsBlock(materials: Material[]): string {
  let total = 0;
  const parts: string[] = [];
  for (const m of materials) {
    const room = LIMITS.totalMaterialChars - total;
    if (room <= 0) break;
    const text = m.text.slice(0, room);
    total += text.length;
    parts.push(`[자료: ${m.title} (ID ${m.id})]\n${text}`);
  }
  return parts.length ? parts.join("\n\n") : "(지시서에 연결된 참고 자료 없음)";
}

async function converse(
  env: Env,
  notion: Notion,
  budget: Budget,
  s: JobSettings,
  instruction: string,
  materials: Material[],
  notes: string[],
): Promise<{ answer: FinalAnswer; usage: Usage; researchUsed: number }> {
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(s.selfResearch, s.rounds) },
    { role: "user", content: `[지시서]\n${instruction}\n\n[함께 받은 자료]\n${materialsBlock(materials)}` },
  ];
  const usage: Usage = { input: 0, output: 0 };
  let researchUsed = 0;
  const maxCalls = s.selfResearch ? s.rounds + 2 : 2;

  for (let call = 0; call < maxCalls; call++) {
    const r = await chat(env, budget, s.worker, s.model, messages);
    usage.input += r.usage.input;
    usage.output += r.usage.output;
    const action = parseModelOutput(r.text);
    if (action.action === "final") return { answer: action.answer, usage, researchUsed };

    messages.push({ role: "assistant", content: r.text });
    const canResearch =
      s.selfResearch && researchUsed < s.rounds && budget.remaining() >= LIMITS.writeReserve + 4 && call < maxCalls - 2;

    if (action.action === "invalid") {
      if (call >= maxCalls - 1) return { answer: fallbackAnswer(r.text), usage, researchUsed };
      messages.push({ role: "user", content: "약속한 JSON 형식이 아닙니다. JSON 객체 하나만 다시 출력하세요." });
      continue;
    }
    if (!canResearch) {
      if (s.selfResearch && researchUsed >= s.rounds) notes.push(`자체조사 한도(${s.rounds}회)를 모두 썼습니다.`);
      messages.push({ role: "user", content: "더 이상 자료를 요청할 수 없습니다. 지금까지 받은 자료로 final JSON을 출력하세요." });
      continue;
    }
    researchUsed++;
    messages.push({ role: "user", content: await runResearch(env, notion, action) });
  }
  return {
    answer: fallbackAnswer("모델이 정해진 횟수 안에 최종 답을 내지 못했습니다."),
    usage,
    researchUsed,
  };
}

async function runResearch(
  env: Env,
  notion: Notion,
  action: { action: "search"; query: string } | { action: "read"; pageId: string },
): Promise<string> {
  try {
    if (action.action === "search") {
      const data = await notion.search(action.query);
      const rows = (data.results ?? [])
        // 요청함 행 자체는 검색 결과에서 뺍니다.
        .filter((p: Json) => p.parent?.data_source_id !== env.NOTION_REQUESTS_DS_ID)
        .map((p: Json) => `- ${pageTitle(p)} (ID ${p.id})`);
      return rows.length
        ? `[검색 결과: "${action.query}"]\n${rows.join("\n")}\n필요하면 read로 본문을 요청하세요.`
        : `[검색 결과: "${action.query}"] 맞는 페이지가 없습니다(실행기와 공유된 페이지만 검색됩니다).`;
    }
    const id = notionId(action.pageId);
    if (!id) return `[읽기 실패] "${action.pageId}"는 노션 페이지 ID가 아닙니다.`;
    const m = await readPageText(notion, id);
    return `[자료: ${m.title} (ID ${m.id})]\n${m.text}`;
  } catch (e) {
    if (e instanceof BudgetError) throw e;
    return `[조사 실패] ${e instanceof Error ? e.message : String(e)}`;
  }
}

const bullets = (items: string[]) => (items.length ? items.map((x) => `- ${x}`).join("\n") : "- 없음");

export function renderResult(s: JobSettings, a: FinalAnswer, usage: Usage, researchUsed: number): string {
  const info = [
    `- 작업자: ${s.worker}${s.worker === "Hive 검사" ? "" : ` · 모델: ${s.model}`}`,
    s.selfResearch ? `- 자체조사: ${researchUsed}회 사용 / 최대 ${s.rounds}회` : "- 자체조사: 사용 안 함",
    usage.input || usage.output ? `- 토큰: 입력 ${usage.input} · 출력 ${usage.output}` : "- 토큰: 응답에 사용량 정보 없음",
    `- 실행 시각: ${kst()} (KST)`,
  ];
  return [
    "### 새 결과",
    a.result,
    "### 근거",
    bullets(a.evidence),
    "### 한계",
    bullets(a.limits),
    "### 다음 할 일",
    bullets(a.nextSteps),
    "### 사용한 자료",
    bullets(a.sources),
    "### 실행 정보",
    ...info,
  ].join("\n");
}

async function writeResult(
  env: Env,
  notion: Notion,
  row: Json,
  s: JobSettings,
  instruction: string,
  resultMd: string,
  lease: Lease,
): Promise<JobOutcome> {
  const rowUrl: string = row.url ?? "";
  const heading = `${RESULT_HEADING} · ${kst()}`;
  let recordUrl: string | undefined;
  let verifyProblem: string | undefined;

  if (s.record) {
    const children = [
      ...markdownToBlocks(`### 지시서\n${instruction.slice(0, 3000)}${instruction.length > 3000 ? "\n(이하 생략)" : ""}`),
      divider(),
      ...markdownToBlocks(resultMd),
    ];
    const record = await notion.createPage(
      env.NOTION_RECORDS_DS_ID,
      {
        제목: prop.title(`${s.title} · ${kst().slice(0, 12)}`),
        요청: prop.relation([row.id]),
        작업자: prop.select(s.worker),
        모델: prop.text(s.worker === "Hive 검사" ? "" : s.model),
        검토: prop.select("미검토"),
      },
      children,
    );
    recordUrl = record.url;
    // 저장 확인: 새 페이지를 다시 읽어 보낸 내용과 비교합니다.
    const back = await notion.listChildren(record.id, 3);
    if (blocksFingerprint(back.blocks) !== blocksFingerprint(children)) {
      verifyProblem = "작업 기록 페이지를 다시 읽었더니 보낸 내용과 다릅니다. 기록 페이지를 직접 확인해 주세요.";
    }
    const rowBlocks = [divider(), ...markdownToBlocks(`## ${heading}`), linkParagraph("작업 기록에 저장했습니다: ", recordUrl ?? "")];
    const echoed = await notion.appendChildren(row.id, rowBlocks);
    if (echoed.length !== rowBlocks.length) verifyProblem ??= "요청 행에 결과 링크를 덧붙였지만 저장 응답이 맞지 않습니다.";
  } else {
    const rowBlocks = [divider(), ...markdownToBlocks(`## ${heading}\n${resultMd}`)];
    const echoed = await notion.appendChildren(row.id, rowBlocks);
    if (blocksFingerprint(echoed) !== blocksFingerprint(rowBlocks)) {
      verifyProblem = "요청 행에 결과를 덧붙였지만 저장 응답이 보낸 내용과 다릅니다. 행 본문을 직접 확인해 주세요.";
    }
  }

  const status = verifyProblem ? STATUS.verifyFailed : STATUS.done;
  await notion.updatePage(row.id, {
    상태: prop.select(status),
    오류: prop.text(verifyProblem ?? ""),
    "완료 시각": prop.date(new Date().toISOString()),
    "결과 페이지": prop.url(recordUrl ?? null),
    "내부 상태": prop.text(JSON.stringify({ attempts: lease.attempts, finished: new Date().toISOString() })),
  });
  return { status, rowUrl, recordUrl, resultMarkdown: resultMd, error: verifyProblem };
}

async function safeFail(notion: Notion, rowId: string, message: string, lease: Lease) {
  try {
    await notion.updatePage(rowId, {
      상태: prop.select(STATUS.failed),
      오류: prop.text(message.slice(0, 1900)),
      "내부 상태": prop.text(JSON.stringify({ attempts: lease.attempts, failed: new Date().toISOString() })),
    });
  } catch (e) {
    // 실패 표시조차 못 하면 로그에만 남깁니다. 실행 중 표시는 lease 시간이 지나면 다시 처리됩니다.
    console.error("실패 상태 기록 불가:", e instanceof Error ? e.message : e);
  }
}
