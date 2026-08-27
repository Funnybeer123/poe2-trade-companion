export interface Clock {
  nowMs(): number;
}

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
}

export class FrozenClock implements Clock {
  constructor(private ms: number) {}

  nowMs(): number {
    return this.ms;
  }

  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
}
