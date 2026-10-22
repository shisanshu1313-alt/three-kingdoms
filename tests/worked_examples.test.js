// balance.worked_examples → 单测（v0.3：结构化 a/b 队伍 + 由 tools/calc_examples.py 算出的 expect）。逐项比对，不放宽。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveCombat, computePower, mainGeneral } from '../src/systems/combat.js';
import { buildTeam, indexBalance } from '../src/systems/teams.js';

const balance = JSON.parse(readFileSync(new URL('../src/data/balance.json', import.meta.url)));
const idx = indexBalance(balance);

const mk = (id, side) => buildTeam({
  id, faction: side.is_player ? 'player' : 'bandit', is_player: !!side.is_player, soldiers: side.soldiers,
  generals: side.generals, items: side.items, position: { x: 0, y: 0 }
}, balance, () => 0.5, idx, () => 'x').team;
// expect 中的浮点值保留 6 位小数（脚本 round(x, 6)）
const near6 = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) <= 5e-7 + 1e-12, `${msg}: actual ${actual} vs expected ${expected}`);

for (const ex of balance.worked_examples) {
  test(`${ex.id}: ${ex.desc}`, async (t) => {
    assert.ok(ex.a && ex.b, 'v0.3 起每个例子都应带结构化 a/b');
    const a = mk('A', ex.a), b = mk('B', ex.b);
    const r = resolveCombat(a, b, balance, null, { rolls: ex.rolls });
    const e = ex.expect;
    const L = r.winner === 'A' ? b : a;
    const floats = {
      power_a: computePower(a, balance), power_b: computePower(b, balance),
      rolled_a: r.a.rolled, rolled_b: r.b.rolled, ratio: r.ratio, duration_s: r.duration_s,
      reduction_winner: r.reductionWinner, reduction_loser: r.reductionLoser,
      winner_losses_raw: r.winnerLossesRaw, loser_dead_raw: r.loserDeadRaw, recruit_rate: r.recruitRate
    };
    const ints = {
      outcome: r.outcome, winner_losses: r.winnerLosses, loser_dead: r.loserDead, loser_survivors: r.loserSurvivors,
      player_kept: r.playerKept, recruit_base: r.recruitBase, recruited: r.recruited, winner_soldier_cap: r.winnerSoldierCap,
      winner_soldiers_after: r.winnerSoldiersAfter, bully: r.bully, points: r.points
    };
    for (const [k, v] of Object.entries(e)) {
      if (k === 'capture') continue;
      if (k in floats) await t.test(k, () => near6(floats[k], v, k));
      else if (k in ints) await t.test(k, () => assert.equal(ints[k], v, k));
      else await t.test(k, () => assert.fail(`测试未覆盖 expect.${k}`));
    }
    for (const [who, p] of Object.entries(e.capture || {})) {
      await t.test(`capture ${who}`, () => {
        const g = L.generals.find(x => x.name === who || x.id === who);
        assert.ok(g, `败方没有武将 ${who}`);
        near6(r.capture[g.id], p, `capture ${who}`);
      });
    }
  });
}

test('主将 = 统率最高（并列取靠前）：ex2 取廖化、ex3 取赵云', () => {
  const ex = Object.fromEntries(balance.worked_examples.map(e => [e.id, e]));
  assert.equal(mainGeneral(mk('A', ex.ex2.a), balance).id, 'liaohua');
  assert.equal(mainGeneral(mk('A', ex.ex3.a), balance).id, 'zhaoyun');
  const tie = { generals: [{ id: 'x', lead: 50 }, { id: 'y', lead: 50 }] };
  assert.equal(mainGeneral(tie, balance).id, 'x');
});
