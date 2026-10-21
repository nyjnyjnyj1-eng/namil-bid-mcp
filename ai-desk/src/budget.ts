// 실행 1회의 외부 호출 횟수를 셉니다. 한도를 넘기 전에 멈추기 위한 장치입니다.
export class BudgetError extends Error {
  constructor() {
    super("이번 실행의 외부 호출 한도에 도달했습니다.");
    this.name = "BudgetError";
  }
}

export class Budget {
  used = 0;
  constructor(readonly limit: number) {}

  remaining(): number {
    return this.limit - this.used;
  }

  async fetch(input: string, init?: RequestInit): Promise<Response> {
    if (this.used >= this.limit) throw new BudgetError();
    this.used++;
    return fetch(input, init);
  }
}

export class ApiError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
    body: string,
  ) {
    super(`${service} API 오류 (${status}): ${body.replace(/\s+/g, " ").slice(0, 300)}`);
    this.name = "ApiError";
  }
}
