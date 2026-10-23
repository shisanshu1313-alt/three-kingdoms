// 策划 tuning_r2.decisions.U1 = B（用户 2026-10-23 定）：开局第一次来袭 20 s → 50 s（数值来自配置）。U2（不改）/ U3（权重待定）不进配置。npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildV06 } from '../scripts/sync-v06.mjs';
import { balance, run, v06 } from '../src/data/index.js';
import { firstBattleAtS } from '../src/systems/runConfig.js';
import { createRun, runTick } from '../src/systems/run.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/balance_v0.6.json', import.meta.url), 'utf8'));

test('同步：decisions.U1 = B → v06.tuning.first_battle_at_s（和 fixtures 一致），from = run_v05 原值', () => {
  const built = buildV06(fixture).tuning;
  assert.equal(fixture.tuning_r2.decisions.U1.choice, 'B');
  assert.deepEqual(v06.tuning.first_battle_at_s, built.first_battle_at_s);
  assert.deepEqual(built.first_battle_at_s, { id: 'U1', choice: 'B', from: 20, to: 50 });
  assert.equal(built.first_battle_at_s.from, run.first_battle.at_s, 'from = run_v05.json first_battle.at_s');
  // U3：general_A 权重不动（待策划定值）
  assert.equal(JSON.stringify(buildV06(fixture)).includes('general_A_weight'), false);
  // 没选 B / 没有 decisions → 不覆盖
  const noU1 = structuredClone(fixture); delete noU1.tuning_r2.decisions;
  assert.equal(buildV06(noU1).tuning.first_battle_at_s, null);
  const a = structuredClone(fixture); a.tuning_r2.decisions.U1.choice = 'A';
  assert.equal(buildV06(a).tuning.first_battle_at_s, null);
});

test('firstBattleAtS：有 tuning → 50 s；不传 / TUNING=off（null）→ run_v05 原值 20 s', () => {
  assert.equal(firstBattleAtS(run, balance.v06.tuning), 50);
  assert.equal(firstBattleAtS(run, null), 20);
  assert.equal(firstBattleAtS(run, { first_battle_at_s: null }), 20);
});

test('runTick：49.9 s 还没来袭，50 s 来袭（只发一次）', () => {
  const r = createRun({ runId: 't', runSeed: 1, cfg: run });
  const p = { soldiers: 30, cap: 60, power: 60, inBattle: false, inCity: false };
  const T = balance.v06.tuning, dt = 0.1;
  let raidAt = null;
  for (let t = 0; t <= 52; t = Math.round((t + dt) * 10) / 10) {
    const ev = runTick(r, t, dt, p, run, T);
    if (ev.some(e => e.type === 'raid')) { assert.equal(raidAt, null, '只来一次'); raidAt = t; }
  }
  assert.equal(raidAt, 50);
  assert.match(readFileSync(new URL('../src/scenes/WorldScene.js', import.meta.url), 'utf8'), /runCfg, balance\.v06\?\.tuning\);/);
});
