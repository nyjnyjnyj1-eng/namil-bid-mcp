import {
  blocksFingerprint,
  blocksToText,
  divider,
  expandTables,
  linkParagraph,
  markdownToBlocks,
  notionId,
  notionRefsFromText,
  RESULT_HEADING,
  tableCount,
} from "./blocks";
import { Budget, BudgetError, isTransient } from "./budget";
import { Env, LIMITS } from "./env";
import { Json, Notion, pageTitle, plain, prop } from "./notion";
import { fallbackAnswer, FinalAnswer, parseModelOutput, SIMPLE_PROMPT, structuredPrompt } from "./protocol";
import {
  chat,
  ChatMessage,
  HealthStore,
  hiveCheck,
  PROVIDER_LABEL,
  ProviderId,
  Usage,
  WORKER_LABEL,
  WorkerChoice,
  workerFromName,
} from "./providers";
import { clip, errorMessage, kst } from "./util";

// 작업 하나가 거치는 단계. 단계마다 따로 실행되어(Durable Object 알람) 무료 플랜의 1회 한도를 넘지 않고,
// 중간에 멈춰도 마지막으로 끝난 단계부터 이어서 합니다.
export type Phase = "gather" | "think" | "check" | "write_record" | "write_row" | "fail" | "done" | "failed";
export type JobStatus = "대기" | "실행 중" | "완료" | "실패" | "저장 확인 실패";

export interface JobInput {
  source: "web" | "notion";
  title: string;
  text?: string; // 웹에서 보낸 요청 글
  rowId?: string; // 노션 요청함 행
  rowUrl?: string;
  worker: WorkerChoice;
  notionSearch: boolean;
  save: boolean;
  rounds: number;
  model?: string;
  requester?: string;
}

export interface JobState {
  v: 2;
  id: string;
  input: JobInput;
  phase: Phase;
  status: JobStatus;
  progress: string;
  structured: boolean;
  instruction?: string;
  notes: string[];
  messages?: ChatMessage[];
  calls: number;
  researchUsed: number;
  corrections: number;
  provider?: ProviderId;
  model?: string;
  skipped: string[];
  usage: Usage;
  answer?: FinalAnswer;
  answerText?: string;
  answeredAt?: number;
  resultMarkdown?: string;
  recordId?: string;
  recordUrl?: string;
  recordSent?: number;
  recordChecked?: boolean;
  rowAppended?: boolean;
  verifyProblem?: string;
  error?: string;
  retries: number;
  resumes?: number;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
}

export interface JobSummary {
  id: string;
  title: string;
  source: "web" | "notion";
  status: JobStatus;
  progress: string;
  provider?: string;
  createdAt: number;
  updatedAt: number;
  recordUrl?: string;
  rowUrl?: string;
}

export interface JobView extends JobSummary {
  phase: Phase;
  worker: string;
  save: boolean;
  notionSearch: boolean;
  model?: string;
  skipped: string[];
  notes: string[];
  usage: Usage;
  resultMarkdown?: string;
  error?: string;
  instruction?: string;
  finishedAt?: number;
}

export interface Deps {
  env: Env;
  budget: Budget;
  notion: Notion | null;
  health: HealthStore;
  // 노션에 이미 쓴 것(기록 페이지 ID 등)을 바로 저장해, 다시 시도할 때 같은 것을 두 번 쓰지 않게 합니다.
  checkpoint: (patch: Partial<JobState>) => Promise<void>;
}

export class JobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobError";
  }
}

export function isTerminal(s: Pick<JobState, "phase">): boolean {
  return s.phase === "done" || s.phase === "failed";
}

export function firstLine(text: string): string {
  return (text.split("\n").find((l) => l.trim()) ?? "").trim();
}

export function newState(id: string, input: JobInput, now = Date.now()): JobState {
  const structured = input.save || input.notionSearch || input.source === "notion" || input.worker === "hive-check";
  return {
    v: 2,
    id,
    input,
    phase: "gather",
    status: "실행 중",
    progress: input.source === "notion" ? "노션 요청을 읽는 중" : "준비 중",
    structured,
    notes: [],
    calls: 0,
    researchUsed: 0,
    corrections: 0,
    skipped: [],
    usage: { input: 0, output: 0 },
    retries: 0,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------- 노션 요청함 행 → 작업 입력 ----------

export function inputFromRow(row: Json): JobInput {
  const p = row.properties ?? {};
  const rawRounds = Number(p["최대 조사 횟수"]?.number ?? LIMITS.defaultRounds);
  const rounds = Math.max(1, Math.min(LIMITS.maxRounds, Number.isFinite(rawRounds) ? Math.floor(rawRounds) : LIMITS.defaultRounds));
  return {
    source: "notion",
    title: pageTitle(row),
    rowId: row.id,
    rowUrl: row.url,
    worker: workerFromName(p["작업자"]?.select?.name),
    notionSearch: Boolean(p["노션에서 찾기"]?.checkbox ?? p["자체조사"]?.checkbox),
    save: Boolean(p["노션 기록"]?.checkbox),
    rounds,
    model: plain(p["모델"]?.rich_text).trim() || undefined,
    requester: p["요청자"]?.select?.name,
  };
}

// ---------- 자료 읽기 ----------

interface Material {
  title: string;
  id: string;
  text: string;
}

async function readPageText(notion: Notion, id: string): Promise<Material> {
  const page = await notion.getPage(id);
  const children = await notion.listChildren(id, 1);
  const t = blocksToText(await expandTables(notion, children.blocks));
  let text = t.text;
  if (children.truncated) text += "\n(이후 내용은 길어서 생략됨)";
  if (t.skippedNested) text += `\n(토글·중첩 블록 ${t.skippedNested}개 안쪽 내용은 읽지 않음)`;
  return { title: pageTitle(page), id, text: clip(text, LIMITS.perPageChars) };
}

async function readReferences(notion: Notion | null, refs: string[], notes: string[]): Promise<Material[]> {
  if (!refs.length) return [];
  if (!notion) {
    notes.push("노션 연결(NOTION_TOKEN)이 없어 붙인 노션 링크를 읽지 못했습니다.");
    return [];
  }
  const out: Material[] = [];
  for (const id of refs.slice(0, LIMITS.maxRefs)) {
    if (notion.callsLeft() < 8) {
      notes.push("호출 한도 때문에 일부 노션 페이지를 읽지 못했습니다.");
      break;
    }
    try {
      out.push(await readPageText(notion, id));
    } catch (e) {
      if (isTransient(e) || e instanceof BudgetError) throw e;
      notes.push(`노션 페이지(${id})를 읽지 못했습니다. 실행기 연결이 그 페이지에 추가되지 않았을 수 있습니다.`);
    }
  }
  if (refs.length > LIMITS.maxRefs) notes.push(`노션 링크가 많아 앞의 ${LIMITS.maxRefs}개만 읽었습니다.`);
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
  return parts.join("\n\n");
}

function userContent(structured: boolean, instruction: string, materials: Material[]): string {
  const mats = materialsBlock(materials);
  if (!structured) return mats ? `${instruction}\n\n[함께 받은 자료]\n${mats}` : instruction;
  return `[지시서]\n${instruction}\n\n[함께 받은 자료]\n${mats || "(지시서에 연결된 참고 자료 없음)"}`;
}

// ---------- 단계 실행 ----------

export async function step(s: JobState, d: Deps): Promise<void> {
  switch (s.phase) {
    case "gather":
      return gather(s, d);
    case "think":
      return think(s, d);
    case "check":
      return check(s, d);
    case "write_record":
      return writeRecord(s, d);
    case "write_row":
      return writeRow(s, d);
    case "fail":
      return reportFailure(s, d);
  }
}

function needNotion(d: Deps): Notion {
  if (!d.notion) throw new JobError("노션 연결(NOTION_TOKEN)이 없어 노션에 쓸 수 없습니다.");
  return d.notion;
}

async function gather(s: JobState, d: Deps): Promise<void> {
  const notes: string[] = [];
  let instruction = "";
  let refs: string[] = [];
  if (s.input.source === "notion") {
    const notion = needNotion(d);
    const body = await notion.listChildren(s.input.rowId!, 2);
    const t = blocksToText(await expandTables(notion, body.blocks), true);
    instruction = t.text;
    refs = t.refs;
    if (body.truncated) notes.push("지시서가 길어 앞부분 200블록만 읽었습니다.");
    if (t.skippedNested) notes.push(`지시서의 토글·중첩 블록 ${t.skippedNested}개 안쪽 내용은 읽지 않았습니다.`);
  } else {
    instruction = s.input.text ?? "";
    refs = notionRefsFromText(instruction);
  }
  if (!instruction.trim()) throw new JobError("요청 내용(지시서)이 비어 있습니다. 노션 요청함이라면 행을 열어 본문에 지시서를 써 주세요.");

  if (s.input.worker === "hive-check") {
    s.instruction = instruction;
    s.notes.push(...notes);
    s.phase = "check";
    s.progress = "Hive 검사 중";
    return;
  }
  const materials = await readReferences(d.notion, refs, notes);
  s.instruction = instruction;
  s.notes.push(...notes);
  s.messages = [
    { role: "system", content: s.structured ? structuredPrompt(s.input.notionSearch, s.input.rounds) : SIMPLE_PROMPT },
    { role: "user", content: userContent(s.structured, instruction, materials) },
  ];
  s.phase = "think";
  s.progress = materials.length ? `노션 자료 ${materials.length}개를 읽고 답을 만드는 중` : "답을 만드는 중";
}

async function think(s: JobState, d: Deps): Promise<void> {
  const maxCalls = !s.structured ? 1 : s.input.notionSearch ? s.input.rounds + 2 : 2;
  const r = await chat(d.env, d.budget, s.input.worker, s.input.model, s.messages!, d.health);
  s.calls++;
  s.usage.input += r.usage.input;
  s.usage.output += r.usage.output;
  s.provider = r.provider;
  s.model = r.model;
  for (const x of r.skipped) if (!s.skipped.includes(x)) s.skipped.push(x);

  if (!s.structured) {
    s.answerText = r.text.trim();
    return finishAnswer(s);
  }
  const action = parseModelOutput(r.text);
  if (action.action === "final") {
    s.answer = action.answer;
    return finishAnswer(s);
  }
  s.messages!.push({ role: "assistant", content: r.text });
  if (s.calls >= maxCalls) {
    s.answer =
      action.action === "invalid" ? fallbackAnswer(r.text) : fallbackAnswer("모델이 정해진 횟수 안에 최종 답을 내지 못했습니다.");
    return finishAnswer(s);
  }
  if (action.action === "invalid") {
    if (s.corrections >= 1) {
      s.answer = fallbackAnswer(r.text);
      return finishAnswer(s);
    }
    s.corrections++;
    s.messages!.push({ role: "user", content: "약속한 JSON 형식이 아닙니다. JSON 객체 하나만 다시 출력하세요." });
    s.progress = "형식을 바로잡아 다시 묻는 중";
    return;
  }
  const canResearch = s.input.notionSearch && !!d.notion && s.researchUsed < s.input.rounds && s.calls < maxCalls - 1;
  if (!canResearch) {
    if (s.input.notionSearch && s.researchUsed >= s.input.rounds) {
      const note = `노션에서 찾기 한도(${s.input.rounds}회)를 모두 썼습니다.`;
      if (!s.notes.includes(note)) s.notes.push(note);
    }
    s.messages!.push({ role: "user", content: "더 이상 자료를 요청할 수 없습니다. 지금까지 받은 자료로 final JSON을 출력하세요." });
    s.progress = "지금까지의 자료로 정리하는 중";
    return;
  }
  s.researchUsed++;
  s.messages!.push({ role: "user", content: await runResearch(d, action) });
  s.progress =
    action.action === "search"
      ? `노션에서 '${clip(action.query, 30)}' 찾아본 뒤 정리하는 중 (${s.researchUsed}/${s.input.rounds})`
      : `노션 페이지를 읽고 정리하는 중 (${s.researchUsed}/${s.input.rounds})`;
}

async function runResearch(
  d: Deps,
  action: { action: "search"; query: string } | { action: "read"; pageId: string },
): Promise<string> {
  const notion = d.notion!;
  try {
    if (action.action === "search") {
      const data = await notion.search(action.query);
      const rows = (data.results ?? [])
        // 요청함 행 자체는 검색 결과에서 뺍니다.
        .filter((p: Json) => p.parent?.data_source_id !== d.env.NOTION_REQUESTS_DS_ID)
        .map((p: Json) => `- ${pageTitle(p)} (ID ${p.id})`);
      return rows.length
        ? `[검색 결과: "${action.query}"]\n${rows.join("\n")}\n필요하면 read로 본문을 요청하세요.`
        : `[검색 결과: "${action.query}"] 맞는 페이지가 없습니다(실행기와 연결된 페이지만 검색됩니다).`;
    }
    const id = notionId(action.pageId);
    if (!id) return `[읽기 실패] "${action.pageId}"는 노션 페이지 ID가 아닙니다.`;
    const m = await readPageText(notion, id);
    return `[자료: ${m.title} (ID ${m.id})]\n${m.text}`;
  } catch (e) {
    // 조사 중 생긴 문제는 모델에게 그대로 알려 주고 계속합니다(같은 모델 호출을 되풀이하지 않도록).
    return `[조사 실패] ${errorMessage(e)}`;
  }
}

async function check(s: JobState, d: Deps): Promise<void> {
  const raw = await hiveCheck(d.env, d.budget, s.instruction ?? "");
  let pretty = raw;
  try {
    pretty = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {}
  s.provider = "hive";
  s.model = "Hive 검사";
  s.answer = {
    result: "Hive 검사 응답 원문입니다.\n\n```\n" + pretty.slice(0, 12000) + "\n```",
    evidence: [],
    limits: ["Hive 응답을 해석하지 않고 원문 그대로 남겼습니다. 점수의 의미는 Hive 문서로 확인하세요."],
    nextSteps: [],
    sources: [],
  };
  if (pretty.length > 12000) s.answer.limits.push("응답이 길어 앞부분 12,000자만 남겼습니다.");
  finishAnswer(s);
}

// ---------- 결과 정리 ----------

const bullets = (items: string[]) => (items.length ? items.map((x) => `- ${x}`).join("\n") : "- 없음");

export function providerLine(s: Pick<JobState, "provider" | "model">): string {
  if (!s.provider) return "";
  const short = (s.model ?? "").replace(/^@cf\/[^/]+\//, "");
  return short && short !== PROVIDER_LABEL[s.provider] ? `${PROVIDER_LABEL[s.provider]} (${short})` : PROVIDER_LABEL[s.provider];
}

function infoLines(s: JobState): string[] {
  const lines = [`- 처리: ${providerLine(s)}`];
  if (s.skipped.length) lines.push(`- 건너뜀: ${s.skipped.join(" / ")}`);
  lines.push(s.input.notionSearch ? `- 노션에서 찾기: ${s.researchUsed}회 / 최대 ${s.input.rounds}회` : "- 노션에서 찾기: 사용 안 함");
  if (s.usage.input || s.usage.output) lines.push(`- 토큰: 입력 ${s.usage.input} · 출력 ${s.usage.output}`);
  lines.push(`- 시각: ${kst(s.answeredAt ?? Date.now())} (한국 시간)`);
  return lines;
}

// 정리 모드에서 모델이 쓴 제목(#, ## …)은 굵은 글씨로 바꿔, '새 결과' 같은 칸 제목과 섞이지 않게 합니다. 코드 블록 안은 그대로 둡니다.
export function flattenHeadings(md: string): string {
  let fenced = false;
  return md
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) fenced = !fenced;
      if (fenced) return line;
      const m = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
      return m ? `**${m[1].replace(/^\*\*(.*)\*\*$/, "$1")}**` : line;
    })
    .join("\n");
}

// '사용한 자료'에 노션 페이지 ID가 적혀 있으면 바로 열 수 있는 링크로 바꿉니다.
export function linkSource(x: string): string {
  const m = /^(.*?)\s*\(?\bID[:\s]*([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})\)?\s*$/i.exec(x);
  if (!m) return x;
  const title = m[1].replace(/[[\]]/g, "").trim() || "노션 페이지";
  return `[${title}](https://www.notion.so/${m[2].replace(/-/g, "").toLowerCase()})`;
}

export function renderResult(s: JobState): string {
  const notes = [...new Set(s.notes)];
  if (!s.structured) {
    let md = s.answerText ?? "";
    if (notes.length) md += `\n\n> 참고: ${notes.join(" / ")}`;
    return md;
  }
  const a = s.answer!;
  return [
    "### 새 결과",
    flattenHeadings(a.result),
    "### 근거",
    bullets(a.evidence),
    "### 한계",
    bullets([...a.limits, ...notes]),
    "### 다음 할 일",
    bullets(a.nextSteps),
    "### 사용한 자료",
    bullets(a.sources.map(linkSource)),
    "### 실행 정보",
    ...infoLines(s),
  ].join("\n");
}

function finishAnswer(s: JobState) {
  s.answeredAt = Date.now();
  s.resultMarkdown = renderResult(s);
  s.messages = undefined; // 다 쓴 대화 기록은 지워 저장 공간을 아낍니다.
  if (s.input.save) {
    s.phase = "write_record";
    s.progress = "노션 작업 기록에 저장하는 중";
  } else if (s.input.source === "notion") {
    s.phase = "write_row";
    s.progress = "노션 요청함에 결과를 붙이는 중";
  } else {
    s.phase = "done";
  }
}

function recordBlocks(s: JobState): Json[] {
  const req = s.instruction ?? "";
  return [
    ...markdownToBlocks(`### 요청\n${clip(req, 3000)}${req.length > 3000 ? "\n(이하 생략)" : ""}`),
    divider(),
    ...markdownToBlocks(s.resultMarkdown ?? ""),
  ];
}

function recordProps(s: JobState): Json {
  const title = s.input.title || clip(firstLine(s.instruction ?? ""), 60) || "AI 작업";
  const props: Json = {
    제목: prop.title(`${title} · ${kst(s.answeredAt ?? Date.now()).slice(0, 10)}`),
    작업자: prop.select(s.input.worker === "hive-check" ? "Hive 검사" : s.provider ? PROVIDER_LABEL[s.provider] : "무료 모델"),
    모델: prop.text(s.model ?? ""),
    검토: prop.select("미검토"),
    출처: prop.select(s.input.source === "notion" ? "요청함" : "웹"),
  };
  if (s.input.rowId) props["요청"] = prop.relation([s.input.rowId]);
  return props;
}

async function writeRecord(s: JobState, d: Deps): Promise<void> {
  const notion = needNotion(d);
  const blocks = recordBlocks(s);
  if (!s.recordId) {
    const page = await notion.createPage(d.env.NOTION_RECORDS_DS_ID, recordProps(s), blocks.slice(0, 100));
    const sent = Math.min(100, blocks.length);
    await d.checkpoint({ recordId: page.id, recordUrl: page.url, recordSent: sent });
    Object.assign(s, { recordId: page.id, recordUrl: page.url, recordSent: sent });
  }
  while ((s.recordSent ?? 0) < blocks.length) {
    const from = s.recordSent ?? 0;
    await notion.appendChildren(s.recordId!, blocks.slice(from, from + 100));
    const sent = Math.min(blocks.length, from + 100);
    await d.checkpoint({ recordSent: sent });
    s.recordSent = sent;
  }
  if (!s.recordChecked) {
    // 저장 확인: 새 페이지를 다시 읽어 보낸 내용과 비교합니다.
    const back = await notion.listChildren(s.recordId!, 3);
    const withRows = tableCount(blocks) <= 3;
    const readBlocks = withRows ? await expandTables(notion, back.blocks, 3) : back.blocks;
    if (blocksFingerprint(readBlocks, withRows) !== blocksFingerprint(blocks, withRows)) {
      s.verifyProblem = "작업 기록 페이지를 다시 읽었더니 보낸 내용과 다릅니다. 기록 페이지를 직접 확인해 주세요.";
    }
    s.recordChecked = true;
  }
  if (s.input.source === "notion") {
    s.phase = "write_row";
    s.progress = "노션 요청함에 결과 링크를 붙이는 중";
  } else {
    s.phase = "done";
  }
}

function finalStatus(s: JobState): JobStatus {
  return s.verifyProblem ? "저장 확인 실패" : "완료";
}

async function writeRow(s: JobState, d: Deps): Promise<void> {
  const notion = needNotion(d);
  const rowId = s.input.rowId!;
  if (!s.rowAppended) {
    const heading = `${RESULT_HEADING} · ${kst(s.answeredAt ?? Date.now())}`;
    const blocks = s.recordUrl
      ? [divider(), ...markdownToBlocks(`## ${heading}`), linkParagraph("작업 기록에 저장했습니다: ", s.recordUrl)]
      : [divider(), ...markdownToBlocks(`## ${heading}\n${s.resultMarkdown ?? ""}`)];
    const echoed = await notion.appendChildren(rowId, blocks);
    let verifyProblem = s.verifyProblem;
    if (blocksFingerprint(echoed, false) !== blocksFingerprint(blocks, false)) {
      verifyProblem ??= "요청 행에 덧붙인 결과가 보낸 내용과 다릅니다. 행 본문을 직접 확인해 주세요.";
    }
    await d.checkpoint({ rowAppended: true, verifyProblem });
    Object.assign(s, { rowAppended: true, verifyProblem });
  }
  await notion.updatePage(rowId, {
    상태: prop.select(finalStatus(s)),
    오류: prop.text(s.verifyProblem ?? ""),
    "완료 시각": prop.date(new Date().toISOString()),
    "결과 페이지": prop.url(s.recordUrl ?? null),
    "처리 모델": prop.text(providerLine(s)),
    "내부 상태": prop.text(JSON.stringify({ job: s.id, finished: new Date().toISOString() })),
  });
  s.phase = "done";
}

async function reportFailure(s: JobState, d: Deps): Promise<void> {
  if (s.input.source === "notion" && s.input.rowId && d.notion) {
    await d.notion.updatePage(s.input.rowId, {
      상태: prop.select("실패"),
      오류: prop.text(clip(s.error ?? "알 수 없는 오류", 1900)),
      "처리 모델": prop.text(providerLine(s)),
      "내부 상태": prop.text(JSON.stringify({ job: s.id, failed: new Date().toISOString() })),
    });
  }
  s.phase = "failed";
}

// 단계 실행 중 오류: 일시적인 오류는 잠시 뒤 다시, 아니면 실패로 정리합니다. 다시 할 때까지 기다릴 시간(ms)을 돌려줍니다.
export function onError(s: JobState, e: unknown): number {
  const msg = errorMessage(e);
  if (isTransient(e) && s.retries < LIMITS.retryDelaysMs.length) {
    const delay = LIMITS.retryDelaysMs[s.retries];
    s.retries++;
    s.progress = `잠시 문제가 있어 ${Math.round(delay / 1000)}초 뒤 다시 시도합니다 (${s.retries}/${LIMITS.retryDelaysMs.length}) — ${clip(msg, 120)}`;
    return delay;
  }
  if (s.phase === "fail") {
    // 실패 기록마저 못 하면 여기서 끝냅니다.
    s.phase = "failed";
    return 0;
  }
  s.error = msg;
  s.phase = "fail";
  s.retries = 0;
  s.progress = "실패 내용을 정리하는 중";
  return 0;
}

export function finalize(s: JobState, now = Date.now()) {
  if (s.phase === "done") {
    s.status = finalStatus(s);
    s.progress = s.verifyProblem ? "저장은 했지만 확인이 필요합니다" : "완료";
  } else if (s.phase === "failed") {
    s.status = "실패";
    s.progress = "실패";
  }
  if (isTerminal(s)) s.finishedAt ??= now;
}

export function summarize(s: JobState): JobSummary {
  return {
    id: s.id,
    title: s.input.title || clip(firstLine(s.instruction ?? s.input.text ?? ""), 60) || "(제목 없음)",
    source: s.input.source,
    status: s.status,
    progress: s.progress,
    provider: providerLine(s) || undefined,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    recordUrl: s.recordUrl,
    rowUrl: s.input.rowUrl,
  };
}

export function viewOf(s: JobState): JobView {
  return {
    ...summarize(s),
    phase: s.phase,
    worker: WORKER_LABEL[s.input.worker],
    save: s.input.save,
    notionSearch: s.input.notionSearch,
    model: s.model,
    skipped: s.skipped,
    notes: [...new Set(s.notes)],
    usage: s.usage,
    resultMarkdown: s.resultMarkdown,
    error: s.error,
    instruction: clip(s.instruction ?? s.input.text ?? "", 4000),
    finishedAt: s.finishedAt,
  };
}
