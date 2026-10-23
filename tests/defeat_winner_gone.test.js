// 回归（策划 tuning_r2 BUG）：胜方同一 tick 也被打败（互相打垮）→ melee.step 已移除胜方战斗体；
// FieldBattle._defeat 读 this.body(W.id).N0 抛 TypeError（melee.js soldiersOf ← fieldBattle.js _defeat），约 6% 的模拟局崩溃。npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import FieldBattle from '../src/systems/fieldBattle.js';
import PartyModel from '../src/systems/party.js';
import { removeBody } from '../src/systems/melee.js';
import { createGameState } from '../src/systems/gameState.js';
import { mulberry32 } from '../src/systems/rng.js';
import { balance, loadInitialTeams, factionColor, resetWorldRandom } from '../src/data/index.js';
import { assignUnit } from '../src/systems/units.js';

const combatJson = JSON.parse(readFileSync(new URL('../src/data/combat_v05.json', import.meta.url)));

function setup() {
  resetWorldRandom();
  const state = createGameState(balance), ends = [];
  const field = new FieldBattle({ combatJson, balance, gameState: state, rng: mulberry32(5), seed: 5, hooks: { onBattleEnd: (pair, outcome) => ends.push(outcome) } });
  const teams = loadInitialTeams().ai.filter(t => t.faction === 'bandit').slice(0, 2), urng = mulberry32(1);
  const [W, L] = teams.map((t, i) => { const p = new PartyModel({ ...assignUnit(t, combatJson, urng), position: { x: 300 + i * 30, y: 300 } }, balance, factionColor(t.faction)); field.add(p); return p; });
  return { field, state, W, L, ends };
}

test('胜方战斗体已被移除（同一 tick 也被打败）时，defeat 事件不崩溃，胜方兵数取事件里的 byN', () => {
  const { field, state, W, L, ends } = setup();
  removeBody(field.state, W.id); // 模拟 melee.step 第 7 步：胜方同 tick 也 dead → 战斗体已删，队伍还在
  assert.equal(field.body(W.id), undefined);
  const e = { type: 'defeat', id: L.id, cause: 'wipe', by: W.id, shares: { [W.id]: 1 }, n: 0, n0: 12, E: 1, power0: 40, byN: 7.4, byN0: 15 };
  let out;
  assert.doesNotThrow(() => { out = field._handle(e, 1000); });
  assert.ok(out && out.removeIds.includes(L.id), '败方照常移除');
  assert.ok(W.team.soldiers >= 7, `胜方兵数按 byN（${W.team.soldiers}）`);
  assert.equal(state.battles, 1); assert.equal(ends.length, 1);
});

test('旧事件（没有 byN）也不崩溃：退回队伍当前兵数', () => {
  const { field, W, L } = setup();
  const before = W.team.soldiers;
  removeBody(field.state, W.id);
  assert.doesNotThrow(() => field._handle({ type: 'defeat', id: L.id, cause: 'rout', by: W.id, shares: { [W.id]: 1 }, n: 3, n0: 10, E: 1, power0: 30 }, 0));
  assert.ok(W.team.soldiers >= before);
});

test('melee.step 的 defeat 事件带胜方兵数 byN / byN0（step 仍是纯函数，只多两个字段）', () => {
  const src = readFileSync(new URL('../src/systems/melee.js', import.meta.url), 'utf8');
  assert.match(src, /type: 'defeat'[\s\S]{0,400}byN: by && B\[by\] \? soldiersOf\(B\[by\]\)/);
  const fb = readFileSync(new URL('../src/systems/fieldBattle.js', import.meta.url), 'utf8');
  assert.match(fb, /wb \? soldiersOf\(wb\) : \(e\.byN/);
  assert.match(fb, /if \(wb\) syncBodyFromTeam/);
});

test('QA-14：玩家胜 → 战报带「兵 开战前→现在」，现在 = HUD 兵力（含收编）', () => {
  const { field, W, L } = setup();
  W.team.is_player = true;
  removeBody(field.state, W.id);
  const out = field._handle({ type: 'defeat', id: L.id, cause: 'rout', by: W.id, shares: { [W.id]: 1 }, n: 4, n0: 12, E: 1, power0: 40, byN: 9, byN0: 15 }, 0);
  assert.match(out.text, /损6\//, out.text);
  assert.ok(out.text.endsWith(` 兵15→${W.team.soldiers}`), out.text);
  assert.ok(W.team.soldiers >= 9, '9 + 收编');
});
