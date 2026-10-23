// 策划 tuning_r2 apply_now：N2 / N3 第 3 / 4 章黄巾刷新战力区间（× 玩家战力）。N1 是模拟脚本（tools/sim-v06.cjs），U1 / U2 待用户定、不实现。npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildV06 } from '../scripts/sync-v06.mjs';
import { balance, run, v06 } from '../src/data/index.js';
import { spawnPowerRange } from '../src/systems/runConfig.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/balance_v0.6.json', import.meta.url), 'utf8'));

test('同步：tuning_r2 的 N2 / N3 进 v06.tuning.chapter_spawn_power（和 fixtures 一致），from 等于 run_v05 原值', () => {
  const built = buildV06(fixture).tuning.chapter_spawn_power;
  assert.deepEqual(v06.tuning.chapter_spawn_power, built);
  const byId = Object.fromEntries(fixture.tuning_r2.apply_now.map(a => [a.id, a]));
  assert.deepEqual(built[2], { id: 'N2', from: byId.N2.from, to: byId.N2.to });
  assert.deepEqual(built[3], { id: 'N3', from: byId.N3.from, to: byId.N3.to });
  for (const [i, o] of Object.entries(built)) assert.deepEqual(run.chapters[i].spawn_power_vs_player, o.from, `第 ${+i + 1} 章原值 = from`);
  assert.equal(Object.keys(built).length, 2, '只有 N2 / N3 两章（U1 走 first_battle_at_s，见 tuning_u1.test.js）');
});

test('spawnPowerRange：第 3 章 [0.6,1.0]、第 4 章 [0.7,1.1]（来自配置），第 1–2 章不变；群雄模式照样 +add', () => {
  const T = balance.v06.tuning, C = T.chapter_spawn_power;
  assert.deepEqual(spawnPowerRange(2, run, false, T), C[2].to);
  assert.deepEqual(spawnPowerRange(3, run, false, T), C[3].to);
  assert.deepEqual(spawnPowerRange(0, run, false, T), run.chapters[0].spawn_power_vs_player);
  assert.deepEqual(spawnPowerRange(1, run, false, T), run.chapters[1].spawn_power_vs_player);
  assert.deepEqual(spawnPowerRange(2, run, false, null), run.chapters[2].spawn_power_vs_player, '不传 tuning = 旧值');
  const add = run.meta.unlocks.find(u => u.id === 'hard_mode')?.spawn_power_add ?? 0;
  assert.deepEqual(spawnPowerRange(3, run, true, T), C[3].to.map(v => v + add));
  assert.match(readFileSync(new URL('../src/scenes/WorldScene.js', import.meta.url), 'utf8'), /spawnPowerRange\(r\.chapter, runCfg, r\.hard, balance\.v06\?\.tuning\)/);
});
