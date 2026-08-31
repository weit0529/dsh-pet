import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopSessionTracker } from '../src/host/desktop-session.ts';

test('桌面会话优先跟随最后聚焦的 Web 页面', () => {
  const tracker = new DesktopSessionTracker(12_000);
  tracker.heartbeat({ clientId: 'a', sessionId: 'session-a', focused: true }, 1_000);
  tracker.heartbeat({ clientId: 'b', sessionId: 'session-b', focused: false }, 2_000);
  assert.equal(tracker.current(3_000), 'session-a');
  tracker.heartbeat({ clientId: 'b', sessionId: 'session-b', focused: true }, 4_000);
  assert.equal(tracker.current(4_001), 'session-b');
});

test('Web 心跳过期后回退最近的 Host 会话事件', () => {
  const tracker = new DesktopSessionTracker(1_000);
  tracker.heartbeat({ clientId: 'a', sessionId: 'session-a', focused: true }, 1_000);
  tracker.sessionEvent('session-event', 1_500);
  assert.equal(tracker.current(2_100), 'session-event');
});
