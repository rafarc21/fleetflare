// #715: warm-pool size is an operator-set tradeoff, never a hardcoded number.
// GATE_WARM_POOL_SIZE absent/invalid = 0 = off, same "zero new behavior until
// opted in" posture as the other gate-runner flags.

export function warmPoolSize(raw: string | undefined): number {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

export function shouldNudgeWarmPool(size: number, flag: string | undefined): boolean {
  return size > 0 && flag === "on";
}
