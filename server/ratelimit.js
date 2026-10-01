// 메모리 기반 고정 윈도 속도 제한 (단일 서버용). 여러 대로 확장 시 Redis 등 공유 저장소로 교체.
export class RateLimiter {
  constructor({ windowMs = 60_000, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map(); // key -> { count, resetAt }
  }

  /** @returns {number} 0 이면 허용, 아니면 재시도까지 남은 초 */
  check(key, now = Date.now()) {
    if (!this.max) return 0;
    let h = this.hits.get(key);
    if (!h || h.resetAt <= now) {
      h = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, h);
      if (this.hits.size > 10_000) this.#sweep(now);
    }
    h.count++;
    return h.count > this.max ? Math.ceil((h.resetAt - now) / 1000) : 0;
  }

  #sweep(now) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
