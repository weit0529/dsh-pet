import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampWindowOrigin,
  desktopWindowDimensions,
  initialWindowOrigin,
  petVisualOffsets,
  windowOriginRange,
} from '../src/desktop/bounds.ts';

const area = { x: 0, y: 0, width: 1920, height: 1080 };
const size = 462;

function justInsideMinimum(actual: number, minimum: number): void {
  assert.ok(actual >= minimum, `${actual} should not be below ${minimum}`);
  assert.ok(actual - minimum < 1, `${actual} should be less than one pixel inside ${minimum}`);
}

function justInsideMaximum(actual: number, maximum: number): void {
  assert.ok(actual <= maximum, `${actual} should not exceed ${maximum}`);
  assert.ok(maximum - actual < 1, `${actual} should be less than one pixel inside ${maximum}`);
}

test('desktop movement range constrains the visible pet instead of the transparent window', () => {
  const dim = desktopWindowDimensions(size);
  const visual = petVisualOffsets(size);
  const range = windowOriginRange(area, size);

  assert.ok(range.minX < area.x);
  assert.ok(range.maxX > area.width - dim.width);
  assert.ok(range.minY < area.y);
  assert.ok(range.maxY > area.height - dim.height);
  justInsideMinimum(range.minX + visual.left, area.x);
  justInsideMaximum(range.maxX + visual.right, area.x + area.width);
  justInsideMinimum(range.minY + visual.top, area.y);
  justInsideMaximum(range.maxY + visual.bottom, area.y + area.height);
});

test('drag clamping keeps every visible edge inside the work area', () => {
  const visual = petVisualOffsets(size);
  const upperLeft = clampWindowOrigin(area, size, -10_000, -10_000);
  const lowerRight = clampWindowOrigin(area, size, 10_000, 10_000);

  justInsideMinimum(upperLeft.x + visual.left, area.x);
  justInsideMinimum(upperLeft.y + visual.top, area.y);
  justInsideMaximum(lowerRight.x + visual.right, area.x + area.width);
  justInsideMaximum(lowerRight.y + visual.bottom, area.y + area.height);
});

test('configured corner margins are measured from the visible pet body', () => {
  const visual = petVisualOffsets(size);
  const topLeft = initialWindowOrigin(area, size, 'top-left', 24, 12);
  const bottomRight = initialWindowOrigin(area, size, 'bottom-right', 24, 12);

  justInsideMinimum(topLeft.x + visual.left, area.x + 24);
  justInsideMinimum(topLeft.y + visual.top, area.y + 12);
  justInsideMaximum(bottomRight.x + visual.right, area.x + area.width - 24);
  justInsideMaximum(bottomRight.y + visual.bottom, area.y + area.height - 12);
});
