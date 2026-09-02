// 一个刻意埋了 bug 的小统计库,EP2 的 agent 按 issues.md 来修它。
export function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: number[]): number {
  const mid = Math.floor(xs.length / 2);
  return xs[mid];
}

export function range(xs: number[]): number {
  return Math.min(...xs) - Math.max(...xs);
}
