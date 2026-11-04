import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = ts.transpileModule(fs.readFileSync(new URL('../src/navigation/glass-motion.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { advanceGlassMotion } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const motion = (patch = {}) => ({ x: 0, y: 30, targetX: 0, targetY: 30, velocityX: 0, velocityY: 0,
  lift: 0, liftVelocity: 0, pressed: false, dragging: false, holdUntil: 0, ...patch });
function settle(state, start = 0) {
  for (let frame = 1; frame <= 240; frame++) if (advanceGlassMotion(state, 1 / 60, start + frame * 1000 / 60)) return;
  assert.fail('The selection must stop animating after it reaches its destination');
}

test('a short tap briefly raises the lens, then fully returns to the flat resting selection', () => {
  const state = motion({ holdUntil: 130 }); let peak = 0;
  for (let frame = 1; frame <= 25; frame++) {
    advanceGlassMotion(state, 1 / 60, frame * 1000 / 60); peak = Math.max(peak, state.lift);
  }
  assert.ok(peak > .6); settle(state, 420);
  assert.equal(state.lift, 0); assert.equal(state.liftVelocity, 0);
});
test('selection travel lifts the bubble and ends at the chosen tab with no residual motion', () => {
  const state = motion({ targetX: 330 }); let peak = 0;
  for (let frame = 1; frame <= 20; frame++) {
    advanceGlassMotion(state, 1 / 60, frame * 1000 / 60); peak = Math.max(peak, state.lift);
  }
  assert.ok(peak > .8); settle(state, 340);
  assert.equal(state.x, 330); assert.equal(state.velocityX, 0); assert.equal(state.lift, 0);
});
test('rapidly choosing a different tab reverses from the current visible position', () => {
  const state = motion({ targetX: 330 });
  for (let i = 1; i < 8; i++) advanceGlassMotion(state, 1 / 60, i * 1000 / 60);
  const current = state.x; state.targetX = 80;
  advanceGlassMotion(state, 1 / 60, 140);
  assert.ok(Math.abs(state.x - current) < 40); settle(state, 140);
  assert.equal(state.x, 80); assert.equal(state.lift, 0);
});
test('releasing a dragged lens settles its inherited momentum and its raised shape', () => {
  const state = motion({ x: 170, targetX: 250, velocityX: 600, lift: 1, dragging: true });
  settle(state);
  assert.equal(state.x, 250); assert.equal(state.velocityX, 0); assert.equal(state.lift, 0);
});
test('reduced motion changes selection immediately and leaves no lifted bubble or animation loop', () => {
  const state = motion({ targetX: 250, targetY: 90, pressed: true, holdUntil: 500, lift: 1, velocityX: 300 });
  assert.equal(advanceGlassMotion(state, 1 / 60, 0, true), true);
  assert.equal(state.x, 250); assert.equal(state.y, 90); assert.equal(state.lift, 0); assert.equal(state.velocityX, 0);
});
test('a backgrounded frame cannot destabilize the selection spring', () => {
  const state = motion({ targetX: 250 });
  advanceGlassMotion(state, 30, 30000);
  assert.ok(Number.isFinite(state.x)); assert.ok(state.x >= 0 && state.x <= 250);
  settle(state, 30000); assert.equal(state.x, 250); assert.equal(state.lift, 0);
});
