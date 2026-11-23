// the stats definitions, kept apart from the database so they can be checked on their own

// succeeded over succeeded plus exhausted. pending and in progress deliveries have no verdict yet,
// so they stay out of both sides. null while nothing has finished
export function successRate(succeeded: number, exhausted: number): number | null {
  const finished = succeeded + exhausted;
  return finished === 0 ? null : succeeded / finished;
}

// a pause that has already passed is no pause
export function activePause(pausedUntil: Date | null, now: Date): Date | null {
  return pausedUntil !== null && pausedUntil.getTime() > now.getTime() ? pausedUntil : null;
}
