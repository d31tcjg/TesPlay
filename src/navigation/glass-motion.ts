export type GlassMotion = {
  x: number; y: number; targetX: number; targetY: number;
  velocityX: number; velocityY: number; lift: number; liftVelocity: number;
  pressed: boolean; dragging: boolean; holdUntil: number;
};

export function advanceGlassMotion(state: GlassMotion, elapsed: number, now: number, reduced = false): boolean {
  if (reduced) {
    Object.assign(state, { x: state.targetX, y: state.targetY, velocityX: 0, velocityY: 0, lift: 0, liftVelocity: 0 });
    return true;
  }
  const moving = Math.hypot(state.targetX - state.x, state.targetY - state.y) > .35 || Math.hypot(state.velocityX, state.velocityY) > 12;
  const liftTarget = state.pressed || moving || now < state.holdUntil ? 1 : 0;
  const step = Math.min(Math.max(elapsed, 0), .032) / 4;
  for (let i = 0; i < 4; i++) {
    const damping = state.dragging ? 39 : 50;
    state.velocityX += ((state.targetX - state.x) * 620 - state.velocityX * damping) * step;
    state.velocityY += ((state.targetY - state.y) * 620 - state.velocityY * damping) * step;
    state.x += state.velocityX * step; state.y += state.velocityY * step;
    state.liftVelocity += ((liftTarget - state.lift) * 750 - state.liftVelocity * 53) * step;
    state.lift += state.liftVelocity * step;
  }
  const settled = Math.hypot(state.targetX - state.x, state.targetY - state.y) < .02 &&
    Math.hypot(state.velocityX, state.velocityY) < .05 && Math.abs(liftTarget - state.lift) < .001 &&
    Math.abs(state.liftVelocity) < .01 && now >= state.holdUntil;
  if (settled) Object.assign(state, { x: state.targetX, y: state.targetY, velocityX: 0, velocityY: 0, lift: liftTarget, liftVelocity: 0 });
  return settled;
}
