// 시험용: Cloudflare의 DurableObject / WorkerEntrypoint 기본 클래스를 흉내 냅니다.
export class DurableObject<E = unknown> {
  constructor(
    public ctx: any,
    public env: E,
  ) {}
}

export class WorkerEntrypoint<E = unknown> {
  constructor(
    public ctx: any,
    public env: E,
  ) {}
}
