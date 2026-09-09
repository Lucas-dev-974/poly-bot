export function nowSec(nowMs: number): number {
  return nowMs / 1000;
}

export function minutesLeft(windowEndSec: number, nowMs: number): number {
  return (windowEndSec - nowSec(nowMs)) / 60;
}
