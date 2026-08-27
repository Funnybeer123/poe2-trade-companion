export function nextLostTargetTicks(previous: number, targetPresent: boolean): number {
  if (targetPresent) {
    return 0;
  }
  return previous + 1;
}
