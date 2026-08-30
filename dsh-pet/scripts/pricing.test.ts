import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateTokenCost, parsePricingCatalogHtml, parsePricingHtml } from '../src/host/pricing-catalog.ts';

const pricingHtml = `
  <table><tr><th>名称</th><th>不是价格表</th></tr></table>
  <table>
    <tr><th>模型</th><th>deepseek-v4-flash</th><th>deepseek-v4-pro</th></tr>
    <tr><td>百万tokens输入（缓存命中）</td><td>空闲时段</td><td>0.05元</td><td>0.15元</td></tr>
    <tr><td>高峰时段</td><td>0.10元</td><td>0.30元</td></tr>
    <tr><td>百万tokens输入（缓存未命中）</td><td>空闲时段</td><td>1.50元</td><td>4.50元</td></tr>
    <tr><td>高峰时段</td><td>3.00元</td><td>9.00元</td></tr>
    <tr><td>百万tokens输出</td><td>空闲时段</td><td>4.50元</td><td>13.50元</td></tr>
    <tr><td>高峰时段</td><td>9.00元</td><td>27.00元</td></tr>
  </table>`;

test('解析真正的价格表与全部模型', () => {
  const catalog = parsePricingCatalogHtml(pricingHtml);
  assert.deepEqual(catalog['deepseek-v4-flash'], {
    input: 1.5,
    cacheRead: 0.05,
    output: 4.5,
    peakMultiplier: 2,
    currency: 'CNY',
  });
  assert.equal(catalog['deepseek-v4-pro'].output, 13.5);
});

test('未知模型不会回落到第一个模型', () => {
  assert.equal(parsePricingHtml(pricingHtml, 'deepseek-unknown'), null);
});

test('缓存写入按缓存未命中输入计价', () => {
  const amount = calculateTokenCost(
    { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
    { input: 1.5, cacheRead: 0.05, output: 4.5, peakMultiplier: 2, currency: 'CNY' },
    false,
  );
  assert.equal(amount, 7.55);
});
