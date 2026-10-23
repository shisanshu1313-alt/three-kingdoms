// 策划 tuning_r2.decisions.U3 = C（用户批准 22~24，策划定 22）：gacha_v06.pools.rare.general_A 12 → 22，其他权重都不动（数值来自配置）。npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildV06 } from '../scripts/sync-v06.mjs';
import { balance, v06 } from '../src/data/index.js';
import { kindWeights } from '../src/systems/gachaOffer.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/balance_v0.6.json', import.meta.url), 'utf8'));

test('同步：decisions.U3 = C、value general_A 22 → v06.gacha.pools.rare.general_A = 22（和 fixtures 一致），其他权重 = 定稿 gacha_v06.pools', () => {
  const U3 = fixture.tuning_r2.decisions.U3;
  assert.equal(U3.choice, 'C');
  assert.deepEqual(U3.value, { 'gacha_v06.pools.rare.general_A': 22 });
  const built = buildV06(fixture);
  assert.deepEqual(v06.gacha.pools, built.gacha.pools);
  assert.deepEqual(built.tuning.gacha_pool_weights, [{ id: 'U3', choice: 'C', path: 'gacha_v06.pools.rare.general_A', from: 12, to: 22 }]);
  const base = fixture.gacha_v06.pools;
  assert.equal(base.rare.general_A, 12, '定稿原值（from）');
  for (const [r, pool] of Object.entries(base)) for (const [k, w] of Object.entries(pool))
    assert.equal(built.gacha.pools[r][k], r === 'rare' && k === 'general_A' ? 22 : w, `${r}.${k}`);
  assert.deepEqual(Object.keys(built.gacha.pools).sort(), Object.keys(base).sort());
  // 没有 value / 不是 C → 不覆盖
  const noVal = structuredClone(fixture); delete noVal.tuning_r2.decisions.U3.value;
  assert.equal(buildV06(noVal).gacha.pools.rare.general_A, 12);
  const b = structuredClone(fixture); b.tuning_r2.decisions.U3.choice = 'A';
  assert.equal(buildV06(b).gacha.pools.rare.general_A, 12);
  // 写错路径 → 同步报错（不默默忽略）
  const bad = structuredClone(fixture); bad.tuning_r2.decisions.U3.value = { 'gacha_v06.pools.rare.general_X': 22 };
  assert.throws(() => buildV06(bad), /U3\.value/);
});

test('游戏里抽卡权重：rare 池 general_A = 22，attr_b 40 / troops_b 35 不变；稀有卡里武将卡占 22 / 97', () => {
  const w = kindWeights('rare', balance, { chapter: 0 });
  assert.equal(balance.v06.gacha.pools.rare.general_A, 22);
  assert.equal(w.general_A, 22);
  assert.equal(balance.v06.gacha.pools.rare.attr_b, 40); assert.equal(balance.v06.gacha.pools.rare.troops_b, 35);
  const sum = Object.values(balance.v06.gacha.pools.rare).reduce((a, b) => a + b, 0);
  assert.equal(sum, 97);
  assert.equal(balance.v06.gacha.pools.epic.general_S, 15, 'S 级武将权重不动');
});
