import type { RequestQueue } from './request-queue.js';
 
interface Lane {
  active: number;
  limit: number;
  waiting: Array<() => void>;
}
 

export class InMemoryRequestQueue implements RequestQueue {
  private readonly lanes = new Map<string, Lane>();
 
  constructor(
    private readonly defaultLimit = 2,
    private readonly limits: Map<string, number> = new Map(),
  ) {}

  setLimit(providerKey: string, limit: number): void {
    this.limits.set(providerKey, limit);
    const lane = this.lanes.get(providerKey);
    if (!lane) return;
 
    lane.limit = limit;
    while (lane.active < lane.limit && lane.waiting.length > 0) {
      const next = lane.waiting.shift();
      if (!next) break;
      lane.active += 1;
      next();
    }
  }
 
  async enqueue<T>(providerKey: string, job: () => Promise<T>): Promise<T> {
    const lane = this.lane(providerKey);
 
    if (lane.active < lane.limit) {
      lane.active += 1;
    } else {
      await new Promise<void>((resolve) => lane.waiting.push(resolve));
    }
 
    try {
      return await job();
    } finally {
      this.release(lane);
    }
  }
 
  stats(providerKey: string): { active: number; waiting: number } {
    const lane = this.lanes.get(providerKey);
    return { active: lane?.active ?? 0, waiting: lane?.waiting.length ?? 0 };
  }
 
  private lane(providerKey: string): Lane {
    let lane = this.lanes.get(providerKey);
    if (!lane) {
      lane = {
        active: 0,
        limit: this.limits.get(providerKey) ?? this.defaultLimit,
        waiting: [],
      };
      this.lanes.set(providerKey, lane);
    }
    return lane;
  }
 
  private release(lane: Lane): void {
    const next = lane.waiting.shift();
    if (next) {
      next();
    } else {
      lane.active -= 1;
    }
  }
}