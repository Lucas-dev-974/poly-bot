export class SeededRng {
  private state: number;

  constructor(seed?: string) {
    this.state = seed ? hashString(seed) : (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
  }

  next(): number {
    // xorshift32
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return (x >>> 0) / 0xffffffff;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }
}

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
