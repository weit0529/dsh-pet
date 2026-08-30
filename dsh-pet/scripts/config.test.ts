import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { balanceEventIndex, balancePercent } from '../src/client/balance.ts';
import { applyUserOverrides, assertClientConfig, stripJsonc } from '../src/client/config.ts';

const defaultSource = readFileSync(new URL('../assets/config.jsonc', import.meta.url), 'utf8');
const defaults = assertClientConfig(JSON.parse(stripJsonc(defaultSource)));

test('默认 JSONC 配置通过完整校验', () => {
  assert.ok(defaults.pets.length > 0);
  assert.ok(defaults.animations.idle.length > 0);
  assert.equal(defaults.deepseekFullBalanceCny, 20);
});

test('用户覆盖只替换提交字段', () => {
  const merged = applyUserOverrides(defaults, { notificationsEnabled: false, deepseekFullBalanceCny: 100 });
  assert.equal(merged.notificationsEnabled, false);
  assert.equal(merged.deepseekFullBalanceCny, 100);
  assert.deepEqual(merged.animations, defaults.animations);
});

test('DeepSeek 余额档位使用可配置满额基准', () => {
  const state = { provider: 'deepseek', kind: 'deepseek' as const, ok: true as const, total: '75.00' };
  assert.equal(balancePercent(state, 100), 25);
  assert.equal(balanceEventIndex(25), 1);
});

test('拒绝重复宠物 id 与非法动画权重', () => {
  assert.throws(() => assertClientConfig({ ...defaults, pets: [defaults.pets[0], defaults.pets[0]] }), /重复/);
  assert.throws(
    () => assertClientConfig({ ...defaults, animationWeights: { idle: 60, turn: 30, move: 20 } }),
    /不能超过 100/,
  );
});
