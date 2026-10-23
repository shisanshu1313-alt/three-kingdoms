// v0.6 battle.no_contact_end_s（策划 2026-10-23）：双方连续 N 秒没接触、没人在追、没人放箭 → 'separated'；之后同 apart（pair_cd_s 不再开打、没有保护）。npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/systems/melee.js';
import { balance } from '../src/data/index.js';
import combatJson from '../src/data/combat_v05.json' with { type: 'json' };

const cfg = { ...M.makeCombatConfig(combatJson, balance), fixedRoll: 1 };
const NC = balance.v06.battle, CD = cfg.cooldown;
const gen = id => ({ id, name: id, lead: 40, str: 40, int: 20, cha: 20, generic: true });
const team = (id, over = {}) => ({ id, faction: id, unit: 'inf', soldiers: 50, generals: [gen('g_' + id)], items: [], position: { x: 0, y: 0 }, ...over });
const R = b => M.radiusOf(M.soldiersOf(b), cfg);
function world(list) {
  const s = M.createCombatState({ seed: 1 });
  for (const [t, x, y] of list) M.addBody(s, M.makeBody({ ...t, position: { x, y } }, balance, cfg, { h: 0 }));
  return s;
}
const stay = s => Object.fromEntries(Object.keys(s.bodies).map(id => [id, { h: s.bodies[id].h, v: 0 }]));
const touch = (s, gap = -2) => { const A = s.bodies.A, B = s.bodies.B; B.x = A.x + R(A) + R(B) + gap; B.y = A.y; };
/** 接触开战 1 tick，然后把 B 拉到间隙 gap（< escape_gap_px，不会走 apart 脱离） */
function stalled(gap = 50) {
  let s = world([[team('A'), 0, 0], [team('B'), 0, 0]]); touch(s);
  s = M.step(s, stay(s), 0.1, cfg);
  assert.equal(Object.keys(s.pairs).length, 1, '开战');
  touch(s, gap);
  return s;
}
const until = (s, n, pred, inputs = stay) => { for (let i = 0; i < n; i++) { s = M.step(s, inputs(s), 0.1, cfg); if (pred(s)) return { s, t: s.t, hit: true }; } return { s, t: s.t, hit: false }; };
const sepEv = s => s.events.find(e => e.type === 'separate' && e.kind === 'separated');

test('配置：battle.no_contact_end_s = 4、chase_frac = 0.5（定稿 battle_v06 已写入，读的是配置，不再走默认值）', () => {
  assert.equal(NC.no_contact_end_s, 4);
  assert.equal(cfg.noContact.end_s, NC.no_contact_end_s);
  assert.equal(cfg.noContact.chase_frac, NC.no_contact_chase_frac);
  assert.equal(NC.no_contact_chase_frac, 0.5);
  assert.ok(!balance.v06._defaults.includes('battle_v06.no_contact_end_s'));
  assert.equal(M.makeCombatConfig(combatJson, { ...balance, v06: undefined }).noContact, null, '没有 v0.6 配置时不启用');
});

test('僵持：都站着、间隙 < escape_gap_px、没人放箭 → no_contact_end_s 后以 separated 结束；没有保护；pair_cd_s 内不再开打', () => {
  const s0 = stalled(50), t0 = s0.t;
  assert.ok(50 < cfg.move.escape_gap_px);
  const r = until(s0, 200, s => !!sepEv(s));
  assert.ok(r.hit, '结束了');
  assert.ok(Math.abs(r.t - t0 - NC.no_contact_end_s) < 0.11, `${r.t - t0}`);
  const s = r.s;
  assert.equal(Object.keys(s.pairs).length, 0);
  assert.ok(!s.bodies.A.foes.length && !s.bodies.B.foes.length);
  assert.ok(s.bodies.A.protectUntil <= s.t && s.bodies.B.protectUntil <= s.t, '没有保护');
  assert.ok(!s.events.some(e => e.type === 'escape'));
  const end = s.events.filter(e => e.type === 'combat-end');
  assert.equal(end.length, 2); assert.ok(end.every(e => e.endKind === 'separated'));
  assert.ok(Math.abs(s.pairCd['A|B'] - (s.t + CD.pair_cd_s)) < 1e-6);
  // pair_cd_s 内贴上也不开战；之后可以
  touch(s);
  const r2 = until(s, Math.round(CD.pair_cd_s / 0.1) - 2, x => Object.keys(x.pairs).length > 0, x => { touch(x); return stay(x); });
  assert.equal(r2.hit, false, 'pair_cd_s 内不再开打');
  const r3 = until(r2.s, 10, x => Object.keys(x.pairs).length > 0, x => { touch(x); return stay(x); });
  assert.equal(r3.hit, true, 'pair_cd_s 之后可以再打');
});

test('在追（接近速度 ≥ chase_frac × vmax）→ 计时清零、不结束', () => {
  let s = stalled(140);
  // B 一直朝 A 走（每 tick 拉回原来的间隙，保持不接触）
  const chase = x => { const inp = stay(x); inp.B = { h: Math.PI, v: M.vmaxOf(x.bodies.B, cfg) }; return inp; };
  const r = until(s, 100, x => !!sepEv(x), x => { x.bodies.B.x = x.bodies.A.x + R(x.bodies.A) + R(x.bodies.B) + 140; x.bodies.B.v = M.vmaxOf(x.bodies.B, cfg); x.bodies.B.h = Math.PI; return chase(x); });
  assert.equal(r.hit, false, '10 s 内没有结束');
  assert.equal(Object.keys(r.s.pairs).length, 1);
});

test('放箭（弓兵对这一对射击）→ 不结束；弹药打完后再过 no_contact_end_s 才结束', () => {
  let s = world([[team('A', { unit: 'arc' }), 0, 0], [team('B', { soldiers: 200 }), 0, 0]]);
  touch(s, 60); // 不接触、在射程内 → 指定目标放箭开战
  s = M.step(s, { ...stay(s), A: { h: 0, v: 0, target: 'B' } }, 0.1, cfg);
  assert.equal(Object.keys(s.pairs).length, 1); assert.equal(s.bodies.A.shooting, 'B');
  const ammo = cfg.move.units.arc.ammo_s;
  assert.ok(ammo > 0);
  const r = until(s, 400, x => !!sepEv(x) || !Object.keys(x.pairs).length, x => { touch(x, 60); return stay(x); });
  assert.ok(r.hit && sepEv(r.s), '最后以 separated 结束');
  assert.ok(r.t >= ammo + NC.no_contact_end_s - 0.25, `弹药 ${ammo}s + ${NC.no_contact_end_s}s，实际 ${r.t}`);
});

test('计时随战斗快照存档：JSON 存 / 读后接着算（结束时刻与不存档一样）；step 不改入参', () => {
  const s0 = stalled(50);
  const a = until(s0, 200, s => !!sepEv(s));
  let s = s0;
  for (let i = 0; i < 25; i++) s = M.step(s, stay(s), 0.1, cfg);
  const p = Object.values(s.pairs)[0];
  assert.ok(p.noContactT > 2, String(p.noContactT));
  const frozen = JSON.stringify(s);
  const loaded = JSON.parse(frozen);
  const b = until(loaded, 200, x => !!sepEv(x));
  assert.equal(b.t, a.t);
  // 纯函数
  M.step(s, stay(s), 0.1, cfg);
  assert.equal(JSON.stringify(s), frozen);
});
