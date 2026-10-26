import { Budget } from "./budget";
import { Env, LIMITS } from "./env";
import { inputFromRow } from "./job";
import { Json, Notion, pageTitle, plain, prop } from "./notion";
import { boardStub, runnerStub } from "./runner";
import { errorMessage } from "./util";

interface Marker {
  job?: string;
  at?: number;
  attempts?: number;
}

function readMarker(row: Json): Marker | null {
  const raw = plain(row.properties?.["내부 상태"]?.rich_text);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

export const rowJobId = (rowId: string) => `row-${rowId}`;

// 1분마다: ① 멈춘 작업을 다시 깨우고 ② 노션 요청함의 '대기' 요청을 가져가 시작합니다.
export async function sweep(env: Env, now = Date.now()): Promise<string> {
  const logs: string[] = [];

  try {
    const recent = await boardStub(env).list();
    for (const j of recent) {
      if (j.status === "실행 중" && now - j.updatedAt > LIMITS.stallMs) {
        const r = await runnerStub(env, j.id).resume();
        logs.push(`재개(${r}): ${j.title}`);
      }
    }
  } catch (e) {
    logs.push(`목록 확인 실패: ${errorMessage(e)}`);
  }

  if (!env.NOTION_TOKEN) {
    logs.push("노션 연결 없음");
    return logs.join(" / ");
  }
  const notion = new Notion(env.NOTION_TOKEN, new Budget(LIMITS.subrequests));
  const res = await notion.queryDataSource(env.NOTION_REQUESTS_DS_ID, {
    filter: {
      or: [
        { property: "상태", select: { equals: "대기" } },
        { property: "상태", select: { equals: "실행 중" } },
      ],
    },
    sorts: [{ timestamp: "created_time", direction: "ascending" }],
    page_size: 20,
  });

  let started = 0;
  for (const row of res.results ?? []) {
    const status = row.properties?.["상태"]?.select?.name;
    const jobId = rowJobId(row.id);
    const marker = readMarker(row);
    try {
      if (status === "대기") {
        if (started >= 3) continue; // 한 번에 3건씩만 시작
        const attempts = marker?.job === jobId ? (marker.attempts ?? 0) + 1 : 1;
        await notion.updatePage(row.id, {
          상태: prop.select("실행 중"),
          오류: prop.text(""),
          "내부 상태": prop.text(JSON.stringify({ job: jobId, at: now, attempts })),
        });
        await runnerStub(env, jobId).start(inputFromRow(row), jobId);
        started++;
        logs.push(`시작: ${pageTitle(row)}`);
      } else if (status === "실행 중") {
        // 실행 정보가 사라진 요청(시작 직후 문제 등)만 여기서 정리합니다. 진행 중인 작업은 위에서 다시 깨웁니다.
        if (marker?.at && now - marker.at < LIMITS.stallMs) continue;
        const view = await runnerStub(env, jobId).view();
        if (view && view.status === "실행 중") continue;
        if (view && view.status !== "실행 중") {
          // 작업은 끝났는데 행 상태만 남은 경우
          await notion.updatePage(row.id, { 상태: prop.select(view.status), 오류: prop.text(view.error ?? "") });
          logs.push(`상태 맞춤: ${pageTitle(row)}`);
          continue;
        }
        const attempts = marker?.attempts ?? 1;
        if (attempts >= 3) {
          await notion.updatePage(row.id, {
            상태: prop.select("실패"),
            오류: prop.text("3번 시도했지만 끝까지 실행되지 않았습니다. 지시서를 줄이거나 다시 '대기'로 바꿔 주세요."),
          });
          logs.push(`실패 처리: ${pageTitle(row)}`);
        } else {
          await notion.updatePage(row.id, {
            상태: prop.select("대기"),
            "내부 상태": prop.text(JSON.stringify({ job: jobId, at: now, attempts })),
          });
          logs.push(`다시 대기: ${pageTitle(row)}`);
        }
      }
    } catch (e) {
      logs.push(`오류(${pageTitle(row)}): ${errorMessage(e)}`);
    }
  }
  return logs.length ? logs.join(" / ") : "할 일 없음";
}
