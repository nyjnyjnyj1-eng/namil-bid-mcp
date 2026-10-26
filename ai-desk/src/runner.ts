import { DurableObject } from "cloudflare:workers";
import { Budget } from "./budget";
import { Env, LIMITS } from "./env";
import {
  Deps,
  finalize,
  isTerminal,
  JobInput,
  JobState,
  JobSummary,
  JobView,
  newState,
  onError,
  step,
  summarize,
  viewOf,
} from "./job";
import { Notion } from "./notion";
import { Health, HealthEntry, HealthStore, ProviderId } from "./providers";
import { cleanEnv, errorMessage } from "./util";

export function boardStub(env: Env) {
  return env.BOARD.get(env.BOARD.idFromName("board"));
}

export function runnerStub(env: Env, jobId: string) {
  return env.RUNNER.get(env.RUNNER.idFromName(jobId));
}

export function boardHealth(env: Env): HealthStore {
  const board = boardStub(env);
  return {
    get: () => board.health(),
    set: (p, h) => board.setHealth(p, h),
  };
}

// 작업 하나 = Durable Object 하나. 단계마다 알람으로 다시 깨어나 이어서 처리합니다.
// 브라우저를 닫거나 휴대폰 화면이 꺼져도 작업은 계속됩니다.
export class JobRunner extends DurableObject<Env> {
  async start(input: JobInput, id: string): Promise<JobView> {
    const cur = await this.ctx.storage.get<JobState>("job");
    if (cur && !isTerminal(cur)) return viewOf(cur);
    const s = newState(id, input);
    await this.ctx.storage.put("job", s);
    await this.ctx.storage.setAlarm(Date.now());
    await this.publish(s);
    return viewOf(s);
  }

  async view(): Promise<JobView | null> {
    const s = await this.ctx.storage.get<JobState>("job");
    return s ? viewOf(s) : null;
  }

  // 멈춘 작업을 다시 깨웁니다. 여러 번 멈추면 실패로 정리합니다.
  async resume(): Promise<string> {
    const s = await this.ctx.storage.get<JobState>("job");
    if (!s) return "missing";
    if (isTerminal(s)) return "terminal";
    s.resumes = (s.resumes ?? 0) + 1;
    if (s.resumes > 3 && s.phase !== "fail") {
      s.error = "작업이 여러 번 중간에 멈춰 중단했습니다. 요청을 줄이거나 다시 보내 주세요.";
      s.phase = "fail";
    }
    s.updatedAt = Date.now();
    await this.ctx.storage.put("job", s);
    await this.ctx.storage.setAlarm(Date.now());
    return "resumed";
  }

  async alarm(): Promise<void> {
    let state = await this.ctx.storage.get<JobState>("job");
    if (!state) return;
    if (isTerminal(state)) {
      // 끝난 작업의 실행 정보 정리(노션에 저장한 결과는 그대로 남음)
      if (Date.now() - (state.finishedAt ?? 0) >= LIMITS.cleanupMs - 60_000) await this.ctx.storage.deleteAll();
      return;
    }
    const env = cleanEnv(this.env);
    const budget = new Budget(LIMITS.subrequests);
    const work = structuredClone(state);
    const live = state;
    const deps: Deps = {
      env,
      budget,
      notion: env.NOTION_TOKEN ? new Notion(env.NOTION_TOKEN, budget) : null,
      health: boardHealth(env),
      checkpoint: async (patch) => {
        Object.assign(live, patch);
        Object.assign(work, patch);
        await this.ctx.storage.put("job", live);
      },
    };
    let delay = 0;
    try {
      await step(work, deps);
      work.retries = 0;
      state = work;
    } catch (e) {
      // 실패한 단계에서 바꾼 내용은 버리고(checkpoint로 저장한 것만 남김) 다시 시도하거나 실패로 정리합니다.
      delay = onError(live, e);
      state = live;
      console.error(`job ${state.id} ${state.phase}:`, errorMessage(e));
    }
    state.updatedAt = Date.now();
    finalize(state);
    await this.ctx.storage.put("job", state);
    await this.publish(state);
    if (!isTerminal(state)) await this.ctx.storage.setAlarm(Date.now() + delay);
    else await this.ctx.storage.setAlarm((state.finishedAt ?? Date.now()) + LIMITS.cleanupMs);
  }

  private async publish(s: JobState) {
    try {
      await boardStub(this.env).upsert(summarize(s));
    } catch (e) {
      console.error("board upsert:", errorMessage(e));
    }
  }
}

// 최근 작업 목록과 모델별 사용 가능 상태를 모아 두는 곳(하나만 있음).
export class Board extends DurableObject<Env> {
  async upsert(sum: JobSummary): Promise<void> {
    const list = (await this.ctx.storage.get<JobSummary[]>("recent")) ?? [];
    const i = list.findIndex((x) => x.id === sum.id);
    if (i >= 0) list[i] = sum;
    else list.unshift(sum);
    list.sort((a, b) => b.createdAt - a.createdAt);
    await this.ctx.storage.put("recent", list.slice(0, LIMITS.recentKeep));
  }

  async list(): Promise<JobSummary[]> {
    return (await this.ctx.storage.get<JobSummary[]>("recent")) ?? [];
  }

  async health(): Promise<Health> {
    return (await this.ctx.storage.get<Health>("health")) ?? {};
  }

  async setHealth(p: ProviderId, h: HealthEntry): Promise<void> {
    const cur = (await this.ctx.storage.get<Health>("health")) ?? {};
    cur[p] = h;
    await this.ctx.storage.put("health", cur);
  }
}
