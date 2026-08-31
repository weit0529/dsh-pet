import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeUserConfig, sanitizeUserConfigPatch } from '../src/host/user-config.ts';

const pet = {
  id: 'pet-1',
  size: 462,
  balanceEnabled: true,
  position: { corner: 'bottom-right', marginX: 24, marginY: 0 },
};

test('局部保存宠物时保留高级配置', () => {
  const patch = sanitizeUserConfigPatch({ pets: [pet] });
  assert.ok(patch);
  const merged = mergeUserConfig(
    {
      notificationsEnabled: false,
      animations: { idle: ['自定义待机'] },
      pricing: { models: { 'deepseek-v4-pro': { output: 12 } } },
    },
    patch,
  );
  assert.equal(merged.notificationsEnabled, false);
  assert.deepEqual(merged.animations, { idle: ['自定义待机'] });
  assert.deepEqual(merged.pricing, { models: { 'deepseek-v4-pro': { output: 12 } } });
});

test('拒绝重复 id、越界尺寸和空配置', () => {
  assert.equal(sanitizeUserConfigPatch({ pets: [pet, pet] }), null);
  assert.equal(sanitizeUserConfigPatch({ pets: [{ ...pet, size: 20 }] }), null);
  assert.equal(sanitizeUserConfigPatch({}), null);
});

test('接受旧式与逐模型定价覆盖', () => {
  assert.ok(sanitizeUserConfigPatch({ pricing: { input: 1.2, output: 3.4 } }));
  assert.ok(
    sanitizeUserConfigPatch({
      pricing: { models: { 'deepseek-v4-pro': { input: 4, cacheRead: 0.1, output: 12, peakMultiplier: 2 } } },
    }),
  );
});

test('桌面开关只接受布尔值并参与安全合并', () => {
  assert.deepEqual(sanitizeUserConfigPatch({ desktopEnabled: true }), { desktopEnabled: true });
  assert.equal(sanitizeUserConfigPatch({ desktopEnabled: 'yes' }), null);
  assert.equal(mergeUserConfig({ notificationsEnabled: true }, { desktopEnabled: false }).notificationsEnabled, true);
});
