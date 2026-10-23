// v0.6 统帅规则（leader_v06）：玩家统帅 = 主角，L = 主角统率 + 0.3×Σ副将；敌方 A3；A4 擅长；主角成长；worked_examples ex2 / ex3 新战力
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balance, index } from '../src/data/index.js';
import { computePower, resolveCombat, soldierCap } from '../src/systems/combat.js';
import { getLeader, leaderLead, affinityBonus, recalcLeader, speedLead, growHero, affinityGeneral } from '../src/systems/leader.js';
import { buildTeam, teamName } from '../src/systems/teams.js';
import { teamStats, makeCombatConfig } from '../src/systems/melee.js';
import cj from '../src/data/combat_v05.json' with { type: 'json' };

const near = (a, b, eps = 5e-7) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const mk = (def) => buildTeam({ faction: 'bandit', position: { x: 0, y: 0 }, items: [], ...def }, balance, () => 0.5, index, () => '头目').team;
const P = (gens, extra = {}) => mk({ id: 'player', faction: 'player', is_player: true, soldiers: 100, generals: gens, ...extra });
const ex = id => balance.worked_examples.find(e => e.id === id);

test('ex2 / ex3（v0.6）：统帅主角 → power_a 252.42 / 689.85（= leader_v06.worked_examples_impact），胜负不变', () => {
  const imp = balance.v06 && { ex2: 252.42, ex3: 689.85 };
  for (const id of ['ex2', 'ex3']) {
    const e = ex(id);
    const a = P(e.a.generals, { soldiers: e.a.soldiers, items: e.a.items }), b = mk({ id: 'B', soldiers: e.b.soldiers, generals: e.b.generals, items: e.b.items });
    near(computePower(a, balance), imp[id], 5e-3);
    const r = resolveCombat(a, b, balance, null, { rolls: e.rolls });
    assert.equal(r.outcome, e.expect.outcome, `${id} 胜负不变`);
    assert.equal(getLeader(a, balance).id, 'hero');
  }
});

test('玩家：统帅永远是主角；L = 主角统率 + 0.3×Σ副将统率（不封顶）；速度用 min(L,100)', () => {
  const t = P(['hero', 'zhaoyun', 'zhugeliang']);
  const hero = t.generals[0], zy = t.generals[1], zg = t.generals[2];
  assert.equal(getLeader(t, balance).id, 'hero');
  near(leaderLead(t, balance), hero.lead + 0.3 * (zy.lead + zg.lead));
  hero.lead = 100; // L = 100 + 0.3×183 > 100
  assert.ok(leaderLead(t, balance) > 100);
  assert.equal(speedLead(t, balance), 100);
  const cfg = makeCombatConfig(cj, balance);
  near(teamStats(t, balance, cfg).leadMult, 1 + cfg.move.lead_speed_k * 50);
});

test('A4：任一副将擅长当前兵种 → M +0.05（不叠加）；主角没有擅长；敌方统帅擅长 +0.10', () => {
  const t = P(['hero', 'zhaoyun', 'guanyu']); t.unit = 'spr'; // 两人都擅长枪兵
  assert.equal(affinityBonus(t, balance), 0.05);
  assert.equal(affinityGeneral(t, balance).id, 'zhaoyun');
  t.unit = 'cav'; assert.equal(affinityBonus(t, balance), 0);
  const solo = P(['hero']); solo.unit = 'inf'; assert.equal(affinityBonus(solo, balance), 0);
  const e = mk({ id: 'x', faction: 'shu', soldiers: 100, generals: ['liaohua', 'guanyu'] }); e.unit = 'spr';
  assert.equal(getLeader(e, balance).id, 'guanyu'); assert.equal(affinityBonus(e, balance), 0.10);
});

test('A3：将才分 统率+武力；并列取统率高，再并列靠前；名将军固定名将（曹操 168 < 夏侯惇 179 仍是曹操）', () => {
  const wei = mk({ id: 'wei_caocao', faction: 'wei', soldiers: 100, generals: ['caocao', 'xiahoudun'] });
  assert.equal(getLeader(wei, balance).id, 'caocao');
  assert.equal(wei.name, '曹操军');
  const other = mk({ id: 'w2', faction: 'wei', soldiers: 100, generals: ['caocao', 'xiahoudun'] });
  assert.equal(getLeader(other, balance).id, 'xiahoudun');
  assert.equal(teamName(other, balance, index), '夏侯惇军');
  // 名将离队 → 按将才分
  wei.generals = wei.generals.filter(g => g.id !== 'caocao'); recalcLeader(wei, balance);
  assert.equal(wei.leaderId, 'xiahoudun');
  const tie = mk({ id: 't', faction: 'bandit', soldiers: 10, generals: [{ name: 'A', lead: 50, str: 60, int: 1, cha: 1 }, { name: 'B', lead: 60, str: 50, int: 1, cha: 1 }, { name: 'C', lead: 60, str: 50, int: 1, cha: 1 }] });
  assert.equal(getLeader(tie, balance).name, 'B');
});

test('recalcLeader：缓存 leaderId 并按 {统帅名}军 刷新队名（名将军 / 玩家队名不变）', () => {
  const t = mk({ id: 'q', faction: 'qun', soldiers: 100, generals: ['huaxiong'] });
  t.generals.push({ ...index.generalsById.lvbu });
  recalcLeader(t, balance, x => teamName(x, balance, index));
  assert.equal(t.leaderId, 'lvbu'); assert.equal(t.name, '吕布军');
  const p = P(['hero', 'zhaoyun']); recalcLeader(p, balance, x => teamName(x, balance, index));
  assert.equal(p.leaderId, 'hero'); assert.equal(p.name, balance.player_faction.team_name);
});

test('主角成长：每进入新章节 统率 +6、武力 +4，上限 100；兵力上限仍是 100 + 2×Σ全队统率', () => {
  const t = P(['hero']); const h = t.generals[0]; const l0 = h.lead, s0 = h.str;
  growHero(t, balance, 3);
  assert.equal(h.lead, Math.min(100, l0 + 18)); assert.equal(h.str, Math.min(100, s0 + 12));
  h.lead = 98; growHero(t, balance, 1); assert.equal(h.lead, 100);
  assert.equal(soldierCap(t, balance), balance.team_rules.soldier_cap_base + 2 * 100 + 60 * 0);
});
