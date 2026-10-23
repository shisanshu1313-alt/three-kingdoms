// v0.5 移动接触式实时战斗：step() 单测 + AI 追击 + 确定性无头模拟。npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as M from '../src/systems/melee.js';
import { combatIntent, newCombatMem } from '../src/systems/combatAI.js';

const balance = JSON.parse(readFileSync(new URL('../src/data/balance.json', import.meta.url)));
const cj = JSON.parse(readFileSync(new URL('../src/data/combat_v05.json', import.meta.url)));
const cfg = { ...M.makeCombatConfig(cj, balance), fixedRoll: 1 };
const MP = cfg.move;
const near = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) < eps, `${msg} ${a} != ${b}`);
const gen = (id, lead = 40, str = 40) => ({ id, name: id, lead, str, int: 20, cha: 20, generic: true });
const team = (id, over = {}) => ({ id, faction: id, unit: 'inf', soldiers: 50, generals: [gen('g_' + id)], items: [], position: { x: 0, y: 0 }, ...over });
const R = (b) => M.radiusOf(M.soldiersOf(b), cfg);

/** 新战斗：bodies = [[team, x, y, h]] */
function world(list, seed = 1) {
  const s = M.createCombatState({ seed });
  for (const [t, x, y, h = 0] of list) M.addBody(s, M.makeBody({ ...t, position: { x, y } }, balance, cfg, { h }));
  return s;
}
/** 让 b 贴到 a 右侧（重叠 2 px） */
const touch = (s, a, b, dx = 1, dy = 0) => { const A = s.bodies[a], Bb = s.bodies[b]; const d = R(A) + R(Bb) - 2; Bb.x = A.x + dx * d; Bb.y = A.y + dy * d; };
const stay = (s) => Object.fromEntries(Object.keys(s.bodies).map(id => [id, { h: s.bodies[id].h, v: 0 }]));
const run = (s, n, inputs = stay) => { const evs = []; for (let i = 0; i < n; i++) { s = M.step(s, typeof inputs === 'function' ? inputs(s) : inputs, 0.1, cfg); evs.push(...s.events); } return { s, evs }; };
const expRate = (Rx) => Math.min(MP.rate_cap, MP.lam * Math.pow(Rx, MP.a));

test('v0.5 配置来自 balance_v0.5.json（move_params 原样）', () => {
  assert.equal(cj._source.version, '0.5'); assert.equal(cj._source.file, 'balance_v0.5.json');
  assert.equal(cj.confirmed.player_wipe_keep_soldiers, undefined, '原型专用的值不再存在');
  assert.equal(cj.confirmed.both_retreating_both_protected, true);
  assert.equal(cfg.tick_s, 0.1);
  assert.equal(cj.cooldown.charge_cd_s, 4); assert.equal(cj.cooldown.protect_s, 8); assert.equal(cj.cooldown.ignore_s, 20); assert.equal(cj.cooldown.pair_cd_s, 10);
  assert.equal(MP.escape_gap_px, 150); assert.equal(MP.escape_s, 2); assert.equal(MP.rear_mult, 1.3); assert.equal(MP.contact_speed_mult, 0.6); assert.equal(MP.morale_rout, 30);
  assert.equal(MP.pursue_max_s, 3); assert.equal(MP.pursue_fast_s, 6);
  assert.deepEqual(MP.counters, { spr: 'cav', cav: 'arc', arc: 'inf', inf: 'spr' });
});

test('step 是纯函数：不改入参，同输入同输出', () => {
  const s0 = world([[team('A'), 0, 0], [team('B'), 0, 0, Math.PI]]); touch(s0, 'A', 'B');
  const copy = structuredClone(s0);
  const s1 = M.step(s0, stay(s0), 0.1, cfg), s2 = M.step(s0, stay(s0), 0.1, cfg);
  assert.deepEqual(s0, copy);
  assert.deepEqual(s1, s2);
});

test('只在接触时掉兵；持续伤害 = min(cap, λ·R^a)·dt，兵数 N0 − N0·raw·(1−减免)', () => {
  // 不接触：不掉
  let s = world([[team('A'), 0, 0], [team('B', { soldiers: 40 }), 300, 0, Math.PI]]);
  ({ s } = run(s, 5));
  assert.equal(s.bodies.A.raw, 0); assert.equal(s.bodies.B.raw, 0); assert.equal(Object.keys(s.pairs).length, 0);
  // 接触（静止贴上，接近速度 0 → 没有冲击）
  s = world([[team('A'), 0, 0], [team('B', { soldiers: 40 }), 0, 0, Math.PI]]); touch(s, 'A', 'B');
  const A0 = s.bodies.A, B0 = s.bodies.B;
  const EA = M.effPower(A0, B0, cfg, 0), EB = M.effPower(B0, A0, cfg, 0);
  const r1 = M.step(s, stay(s), 0.1, cfg);
  assert.ok(r1.events.some(e => e.type === 'engage'));
  assert.ok(!r1.events.some(e => e.type === 'impact'));
  near(r1.bodies.A.raw, expRate(EB / EA) * 0.1, 1e-12, 'raw_A');
  near(r1.bodies.B.raw, expRate(EA / EB) * 0.1, 1e-12, 'raw_B');
  const b = r1.bodies.B;
  near(M.soldiersOf(b), b.N0 - b.N0 * b.raw * (1 - b.stats.red), 1e-12);
  assert.ok(b.stats.red <= balance.power.loss_reduction_total_cap);
});

test('背击 ×1.3：被打的一方背对敌人且在移动', () => {
  const mk = (h) => { const s = world([[team('A'), 0, 0, h], [team('B'), 0, 0, Math.PI]]); touch(s, 'A', 'B'); return s; };
  const face = mk(0), back = mk(Math.PI);
  back.bodies.A.v = M.vmaxOf(back.bodies.A, cfg); // 背对 B 往外跑
  const f1 = M.step(face, stay(face), 0.1, cfg);
  const b1 = M.step(back, { A: { h: Math.PI, v: 999 }, B: { h: Math.PI, v: 0 } }, 0.1, cfg);
  assert.equal(b1.bodies.A.rear, true); assert.equal(f1.bodies.A.rear, false);
  near(b1.bodies.A.raw / f1.bodies.A.raw, MP.rear_mult, 1e-9);
  near(b1.bodies.B.raw, f1.bodies.B.raw, 1e-12); // 对 B 不变
  // 背对但站着不动：不算背击（【假设】rear_min_speed_frac）
  const still = mk(Math.PI);
  assert.equal(M.step(still, stay(still), 0.1, cfg).bodies.A.rear, false);
});

test('冲锋：冲击伤害公式；冷却 4 s 内再接触没有冲击，冷却好了才有', () => {
  const cav = team('C', { unit: 'cav', soldiers: 60, generals: [gen('gc', 60, 55)] });
  let s = world([[team('A', { soldiers: 60 }), 0, 0, Math.PI], [cav, 0, 0, Math.PI]]);
  const setRun = (s) => { const A = s.bodies.A, C = s.bodies.C; C.x = A.x + R(A) + R(C) + 3; C.y = A.y; C.h = Math.PI; C.v = M.vmaxOf(C, cfg); };
  setRun(s);
  const inp = (s) => ({ A: { h: 0, v: 0 }, C: { h: Math.PI, v: 999 } });
  const C0 = s.bodies.C, A0 = s.bodies.A;
  let r = M.step(s, inp(s), 0.1, cfg); // 这一 tick 移动 → 下一 tick 接触
  r = M.step(r, inp(r), 0.1, cfg);
  const imp = r.events.find(e => e.type === 'impact' && e.id === 'C');
  assert.ok(imp, '第一次接触有冲击');
  const ratio = Math.pow(M.effPower(C0, A0, cfg, 0) / M.effPower(A0, C0, cfg, 0), MP.a);
  near(imp.raw, MP.impact_k * (imp.vc / 100) * ratio * MP.units.cav.charge, 1e-3, '冲击伤害');
  assert.ok(imp.vc >= MP.impact_min_closing * M.vmaxOf(r.bodies.C, cfg));
  near(r.bodies.C.cd, cj.cooldown.charge_cd_s, 1e-9, '冷却');
  assert.ok(r.bodies.A.dis > 0, '被冲散');
  // 2 s 后拉开再冲：没有冲击（还在冷却）
  for (let i = 0; i < 20; i++) { setRun(r); r.bodies.C.v = 0; r = M.step(r, { A: { h: 0, v: 0 }, C: { h: Math.PI, v: 0 } }, 0.1, cfg); }
  assert.ok(r.bodies.C.cd > 1.5 && r.bodies.C.cd < 2.1);
  setRun(r); let evs = [];
  for (let i = 0; i < 2; i++) { r = M.step(r, inp(r), 0.1, cfg); evs.push(...r.events); }
  assert.ok(!evs.some(e => e.type === 'impact' && e.id === 'C'), '冷却中不冲击');
  // 冷却好了（再过 2 s+）：再冲有冲击
  for (let i = 0; i < 22; i++) { setRun(r); r.bodies.C.v = 0; r = M.step(r, { A: { h: 0, v: 0 }, C: { h: Math.PI, v: 0 } }, 0.1, cfg); }
  assert.equal(r.bodies.C.cd, 0);
  setRun(r); evs = [];
  for (let i = 0; i < 2; i++) { r = M.step(r, inp(r), 0.1, cfg); evs.push(...r.events); }
  assert.ok(evs.some(e => e.type === 'impact' && e.id === 'C'), '冷却好了再冲击');
});

test('骑兵冲列阵枪兵：被反弹（braced），骑兵自己掉兵', () => {
  const s = world([[team('S', { unit: 'spr' }), 0, 0, 0], [team('C', { unit: 'cav' }), 0, 0, Math.PI]]);
  const S = s.bodies.S, C = s.bodies.C; C.x = R(S) + R(C) + 3; C.v = M.vmaxOf(C, cfg);
  let r = M.step(s, { S: { h: 0, v: 0 }, C: { h: Math.PI, v: 999 } }, 0.1, cfg);
  r = M.step(r, { S: { h: 0, v: 0 }, C: { h: Math.PI, v: 999 } }, 0.1, cfg);
  assert.ok(r.events.some(e => e.type === 'braced' && e.id === 'C'));
  assert.ok(!r.events.some(e => e.type === 'impact'));
});

test('士气 < 30 → 溃逃，AI 判负并按伤害份额结算（worked example E1：A 冲击 0.00713，B 6.2 s 溃，损 5 / 7）', () => {
  const hero = balance.hero;
  const A = { id: 'A', faction: 'player', is_player: true, unit: 'inf', soldiers: 30, generals: [{ ...hero }], items: ['war_drum'], position: { x: 0, y: 0 } };
  const Bt = { id: 'B', faction: 'bandit', unit: 'inf', soldiers: 25, generals: [gen('b', 30, 40)], items: [], position: { x: 60, y: 0 } };
  let s = M.createCombatState({ seed: 1 });
  M.addBody(s, M.makeBody(A, balance, cfg, { h: 0 })); M.addBody(s, M.makeBody(Bt, balance, cfg, { h: Math.PI }));
  const pol = (X, Y) => ({ h: Math.atan2(Y.y - X.y, Y.x - X.x), v: X.inContact ? 0 : 999 });
  const evs = [];
  for (let i = 0; i < 200 && s.bodies.B; i++) { s = M.step(s, { A: pol(s.bodies.A, s.bodies.B), B: pol(s.bodies.B, s.bodies.A) }, 0.1, cfg); evs.push(...s.events); }
  const ia = evs.find(e => e.type === 'impact' && e.id === 'A'), ib = evs.find(e => e.type === 'impact' && e.id === 'B');
  near(ia.raw, 0.00713, 5e-5); near(ib.raw, 0.00424, 5e-5);
  const rout = evs.find(e => e.type === 'rout');
  assert.equal(rout.id, 'B'); near(rout.t, 6.2, 1e-6);
  const def = evs.find(e => e.type === 'defeat');
  assert.equal(def.by, 'A'); assert.deepEqual(def.shares, { A: 1 });
  assert.equal(Math.round(def.n0 - def.n), 7);
  const end = evs.find(e => e.type === 'combat-end' && e.id === 'A');
  assert.equal(end.lost, 5); assert.equal(s.bodies.A.N0, 25);
  assert.equal(s.bodies.B, undefined, '败者移除');
});

test('没有撤退按钮：接触中最大速度 ×0.6；间隙 > 150 px 持续 2 s 才脱离', () => {
  let s = world([[team('A'), 0, 0, Math.PI], [team('B'), 0, 0, Math.PI]]); touch(s, 'A', 'B');
  ({ s } = run(s, 1));
  const vm = M.vmaxOf(s.bodies.A, cfg);
  const away = { A: { h: Math.PI, v: 999 }, B: { h: Math.PI, v: 0 } };
  // 接触中往外开：速度被限制在 0.6 × vmax
  for (let i = 0; i < 6; i++) { s = M.step(s, away, 0.1, cfg); if (s.bodies.A.inContact) assert.ok(s.bodies.A.v <= vm * MP.contact_speed_mult + 1e-9); }
  // 拉到间隙 151 px：开始计时
  s.bodies.A.x = s.bodies.B.x - (R(s.bodies.A) + R(s.bodies.B) + 151); s.bodies.A.v = vm;
  let t0 = null, escT = null, evs = [];
  for (let i = 0; i < 40 && escT === null; i++) {
    s = M.step(s, away, 0.1, cfg); evs.push(...s.events);
    const p = Object.values(s.pairs)[0];
    if (t0 === null && p?.apartT > 0) t0 = s.t - 0.1;
    if (s.events.some(e => e.type === 'escape')) escT = s.t;
  }
  near(escT - t0, MP.escape_s, 1e-6, '脱离计时');
  const esc = evs.find(e => e.type === 'escape');
  assert.equal(esc.id, 'A'); assert.equal(esc.from, 'B');
  assert.ok(evs.some(e => e.type === 'separate' && e.kind === 'escape'));
  assert.equal(s.bodies.A.foes.length, 0); assert.equal(s.bodies.B.foes.length, 0);
  // 间隙一旦回到 150 以内，计时清零
  let s2 = world([[team('A'), 0, 0, Math.PI], [team('B'), 0, 0, Math.PI]]); touch(s2, 'A', 'B'); ({ s: s2 } = run(s2, 1));
  s2.bodies.A.x = s2.bodies.B.x - (R(s2.bodies.A) + R(s2.bodies.B) + 151);
  ({ s: s2 } = run(s2, 10));
  assert.ok(Object.values(s2.pairs)[0].apartT > 0.9);
  s2.bodies.A.x = s2.bodies.B.x - (R(s2.bodies.A) + R(s2.bodies.B) + 100);
  ({ s: s2 } = run(s2, 1));
  assert.equal(Object.values(s2.pairs)[0].apartT, 0);
});

/** A 从 B 逃脱后的状态 */
function escaped() {
  let s = world([[team('A'), 0, 0, Math.PI], [team('B'), 0, 0, Math.PI], [team('C'), 0, 600, 0]]); touch(s, 'A', 'B');
  ({ s } = run(s, 1));
  s.bodies.A.x = s.bodies.B.x - (R(s.bodies.A) + R(s.bodies.B) + 151); s.bodies.A.v = M.vmaxOf(s.bodies.A, cfg);
  const away = (s) => ({ A: { h: Math.PI, v: 999 }, B: { h: Math.PI, v: 0 }, C: { h: 0, v: 0 } });
  for (let i = 0; i < 40; i++) { s = M.step(s, away(s), 0.1, cfg); if (s.events.some(e => e.type === 'escape')) return { s, tEsc: s.t }; }
  throw new Error('no escape');
}

test('逃脱者 8 s 保护：别人贴上来不开战；8 s 后可以', () => {
  let { s, tEsc } = escaped();
  near(s.bodies.A.protectUntil, tEsc + cj.cooldown.protect_s, 1e-6);
  const hold = (s) => { s.bodies.A.v = 0; touch(s, 'A', 'C', 0, 1); return stay(s); };
  let started = null;
  for (let i = 0; i < 100 && started === null; i++) { const inp = hold(s); s = M.step(s, inp, 0.1, cfg); if (s.events.some(e => e.type === 'engage')) started = s.t; }
  assert.ok(started > tEsc + cj.cooldown.protect_s - 1e-6 && started < tEsc + cj.cooldown.protect_s + 0.25, `开战于 ${started}，逃脱于 ${tEsc}`);
});

test('保护期内自己去打人：保护取消（接近速度 ≥ 0.5 vmax）', () => {
  let { s } = escaped();
  const A = s.bodies.A, C = s.bodies.C;
  C.x = A.x; C.y = A.y + R(A) + R(C) - 2; A.h = Math.PI / 2; A.v = M.vmaxOf(A, cfg);
  s = M.step(s, { A: { h: Math.PI / 2, v: 999 }, B: { h: 0, v: 0 }, C: { h: 0, v: 0 } }, 0.1, cfg);
  assert.ok(s.events.some(e => e.type === 'protect-cancel' && e.id === 'A'));
  assert.ok(s.events.some(e => e.type === 'engage'));
  assert.equal(s.bodies.A.protectUntil, 0);
});

test('同一对 10 s 内不再开打（pair_cd_s）', () => {
  let { s, tEsc } = escaped();
  s.bodies.A.protectUntil = 0; // 只看这一对的冷却
  let started = null;
  for (let i = 0; i < 130 && started === null; i++) { s.bodies.A.v = 0; touch(s, 'B', 'A', -1, 0); s = M.step(s, stay(s), 0.1, cfg); if (s.events.some(e => e.type === 'engage')) started = s.t; }
  assert.ok(started > tEsc + cj.cooldown.pair_cd_s - 1e-6 && started < tEsc + cj.cooldown.pair_cd_s + 0.25, `开战于 ${started}，逃脱于 ${tEsc}`);
});

test('第三方加入：伤害按战力份额分摊 = 合并成一队（X100 vs Y1 100 + Y2 60 → 0.0755 / 0.0268 每秒）', () => {
  const t = (id, n, f) => ({ id, faction: f, unit: 'inf', soldiers: n, generals: [], items: [], position: { x: 0, y: 0 } });
  let s = world([[t('X', 100, 'x'), 0, 0], [t('Y1', 100, 'y'), 0, 0, Math.PI], [t('Y2', 60, 'y'), 0, 0, -Math.PI / 2]]);
  touch(s, 'X', 'Y1', 1, 0); touch(s, 'X', 'Y2', 0, 1);
  const r = M.step(s, stay(s), 0.1, cfg);
  near(r.bodies.X.raw / 0.1, 0.045 * Math.pow(1.6, 1.1), 1e-9); near(r.bodies.X.raw / 0.1, 0.0755, 5e-5);
  near(r.bodies.Y1.raw / 0.1, 0.0268, 5e-5); near(r.bodies.Y2.raw / 0.1, 0.0268, 5e-5);
  // 合并成一队（160）对打 X：同样的损失率
  let m = world([[t('X', 100, 'x'), 0, 0], [t('Y', 160, 'y'), 0, 0, Math.PI]]); touch(m, 'X', 'Y');
  const rm = M.step(m, stay(m), 0.1, cfg);
  near(r.bodies.X.raw, rm.bodies.X.raw, 1e-12); near(r.bodies.Y1.raw, rm.bodies.Y.raw, 1e-12); near(r.bodies.Y2.raw, rm.bodies.Y.raw, 1e-12);
  // 后来加入：溃败线按新的战力比重算（不低于已有 raw + 0.05）
  let s3 = world([[t('X', 100, 'x'), 0, 0], [t('Y1', 100, 'y'), 0, 0, Math.PI], [t('Y2', 60, 'y'), 0, 300, -Math.PI / 2]]); touch(s3, 'X', 'Y1');
  ({ s: s3 } = run(s3, 5));
  const brk0 = s3.bodies.X.brk;
  touch(s3, 'X', 'Y2', 0, 1);
  const { s: s4, evs } = run(s3, 1);
  assert.ok(evs.some(e => e.type === 'engage' && (e.a === 'Y2' || e.b === 'Y2')));
  assert.ok(s4.bodies.X.brk > brk0, '第三方加入后 X 变成弱势方，溃败线上升');
  assert.ok(s4.bodies.X.brk >= s4.bodies.X.raw + 0.05 - 1e-9);
});

test('战利分配：按造成伤害份额；收编/俘虏给最大贡献者', async () => {
  const { defeatResult } = await import('../src/systems/fieldBattle.js');
  const t = (id, n, f) => ({ id, faction: f, unit: 'inf', soldiers: n, generals: [gen('g' + id, 40, 40)], items: [], position: { x: 0, y: 0 } });
  let s = world([[t('X', 40, 'x'), 0, 0], [t('Y1', 100, 'y'), 0, 0, Math.PI], [t('Y2', 60, 'y'), 0, 0, -Math.PI / 2]]);
  touch(s, 'X', 'Y1', 1, 0); touch(s, 'X', 'Y2', 0, 1);
  let def = null;
  for (let i = 0; i < 300 && !def; i++) { s = M.step(s, stay(s), 0.1, cfg); def = s.events.find(e => e.type === 'defeat'); }
  assert.equal(def.id, 'X');
  assert.equal(def.by, 'Y1', '战力大、伤害多的 Y1 是最大贡献者');
  near(def.shares.Y1 + def.shares.Y2, 1, 1e-9);
  // 份额 ∝ 各自伤害项 E_Y→X × share_Y(X)，即 ∝ 战力（含武将项，所以比 100:60 略小）
  const p1 = M.powerOf(world([[t('Y1', 100, 'y'), 0, 0]]).bodies.Y1), p2 = M.powerOf(world([[t('Y2', 60, 'y'), 0, 0]]).bodies.Y2);
  assert.ok(def.shares.Y1 > def.shares.Y2 && def.shares.Y1 / def.shares.Y2 < 100 / 60 && def.shares.Y1 / def.shares.Y2 > 0.85 * p1 / p2);
  const W = t('Y1', 100, 'y'), L = t('X', 40, 'x');
  const res = defeatResult(W, L, { ...def, playerShare: 0.5 }, balance);
  assert.ok(res && typeof res === 'object');
});

test('AI 追击：对手在撤时追 3 s 放弃；自己快 10% 以上追 6 s', () => {
  const chase = (unitX, unitT) => {
    const s = world([[team('X', { unit: unitX }), 0, 0, Math.PI], [team('T', { unit: unitT }), -40, 0, Math.PI]]);
    const X = s.bodies.X, T = s.bodies.T;
    X.foes = ['T']; T.foes = ['X']; T.v = M.vmaxOf(T, cfg); // T 背向 X 在跑
    const mem = newCombatMem();
    let t = 0;
    for (; t < 10; t = +(t + 0.1).toFixed(6)) { const it = combatIntent(X, s, mem, cfg, 'normal', 0.1); if (it.mode === 'giveup') break; assert.equal(it.mode, 'pursue'); }
    return t;
  };
  near(chase('inf', 'inf'), MP.pursue_max_s, 0.11);
  assert.ok(M.vmaxOf(world([[team('a', { unit: 'cav' }), 0, 0]]).bodies.a, cfg) >= 1.1 * M.vmaxOf(world([[team('a'), 0, 0]]).bodies.a, cfg));
  near(chase('cav', 'inf'), MP.pursue_fast_s, 0.11);
});

test('兵种克制由配置决定（换 counters / counter_mult 即改变结果）', () => {
  const s = world([[team('S', { unit: 'spr' }), 0, 0], [team('C', { unit: 'cav' }), 0, 0, Math.PI]]);
  const base = M.effPower(s.bodies.S, s.bodies.C, cfg, 0) / (M.powerOf(s.bodies.S) * MP.units.spr.sustain);
  near(base, MP.counter_mult_by_chapter[0], 1e-12);
  near(M.effPower(s.bodies.S, s.bodies.C, cfg, 3) / M.effPower(s.bodies.S, s.bodies.C, cfg, 0), MP.counter_mult_by_chapter[3] / MP.counter_mult_by_chapter[0], 1e-12);
  const cfg2 = { ...cfg, move: { ...MP, counters: { ...MP.counters, spr: 'inf' } } };
  near(M.effPower(s.bodies.S, s.bodies.C, cfg2, 0), M.powerOf(s.bodies.S) * MP.units.spr.sustain, 1e-12);
});

test('确定性无头模拟：同种子 60 s 混战结果完全一致（含 AI 战术与随机 roll）', () => {
  const sim = (seed) => {
    const cfgR = M.makeCombatConfig(cj, balance); // 不固定 roll：用 state.rng
    const units = ['inf', 'cav', 'arc', 'spr'];
    let s = M.createCombatState({ seed });
    for (let i = 0; i < 6; i++) M.addBody(s, M.makeBody(team('P' + i, { faction: i % 2 ? 'red' : 'blue', unit: units[i % 4], soldiers: 30 + i * 7, generals: [gen('g' + i, 30 + i * 5, 35 + i * 3)], position: { x: (i % 3) * 70, y: (i % 2) * 90 } }), balance, cfgR, { h: i }));
    const mem = {}, log = [];
    for (let k = 0; k < 600; k++) {
      const inputs = {};
      for (const [id, X] of Object.entries(s.bodies)) {
        mem[id] ??= newCombatMem();
        const it = M.inCombat(X) ? combatIntent(X, s, mem[id], cfgR, 'aggressive', 0.1) : null;
        const foe = Object.values(s.bodies).filter(Y => Y.faction !== X.faction).sort((p, q) => Math.hypot(p.x - X.x, p.y - X.y) - Math.hypot(q.x - X.x, q.y - X.y))[0];
        inputs[id] = it ?? (foe ? { h: Math.atan2(foe.y - X.y, foe.x - X.x), v: 999 } : { h: X.h, v: 0 });
      }
      s = M.step(s, inputs, 0.1, cfgR);
      for (const e of s.events) log.push(`${e.t}:${e.type}:${e.id ?? e.a ?? ''}`);
    }
    return { log, bodies: Object.values(s.bodies).map(b => [b.id, +b.x.toFixed(6), +b.y.toFixed(6), +M.soldiersOf(b).toFixed(6)]) };
  };
  const a = sim(42), b = sim(42), c = sim(7);
  assert.deepEqual(a, b);
  assert.ok(a.log.some(l => l.includes(':engage:')), '发生了战斗');
  assert.ok(a.log.some(l => l.includes(':defeat:') || l.includes(':escape:') || l.includes(':draw')), '有战斗结束');
  assert.notDeepEqual(a, c, '不同种子（roll）结果不同');
});

test('骑兵冲击-回撤：拉开到助跑距离就停下等冷却，不会自己跑出脱离距离', () => {
  let s = world([[team('A'), 0, 0, 0], [team('C', { unit: 'cav' }), 0, 0, Math.PI]]); touch(s, 'A', 'C');
  const mem = newCombatMem();
  let maxGap = 0, charges = 0;
  for (let i = 0; i < 150 && s.bodies.A && s.bodies.C; i++) {
    const C = s.bodies.C;
    const it = M.inCombat(C) ? combatIntent(C, s, mem, cfg, 'normal', 0.1) : { h: C.h, v: 0 };
    s = M.step(s, { A: { h: s.bodies.A.h, v: 0 }, C: it }, 0.1, cfg);
    if (s.events.some(e => e.type === 'impact' && e.id === 'C')) charges++;
    if (s.bodies.A && s.bodies.C) maxGap = Math.max(maxGap, Math.hypot(s.bodies.C.x - s.bodies.A.x, s.bodies.C.y - s.bodies.A.y) - R(s.bodies.A) - R(s.bodies.C));
    assert.ok(!s.events.some(e => e.type === 'separate' && (e.kind === 'escape' || e.kind === 'apart')), '骑兵不该自己脱离');
  }
  assert.ok(maxGap < MP.escape_gap_px, `最大间隙 ${maxGap}`);
  assert.ok(charges >= 2, `反复冲击 ${charges} 次`);
});

test('策划确认：保护结束后再接触 = 新的一场，士气重置 100、可以再溃一次', () => {
  let { s, tEsc } = escaped();
  s.bodies.A.routOnce = true; s.bodies.A.shock = 25; // 上一场溃过、冲击值还在
  // 同对冷却 10 s 后再贴上 B
  let started = null;
  for (let i = 0; i < 130 && started === null; i++) { s.bodies.A.v = 0; touch(s, 'B', 'A', -1, 0); s = M.step(s, stay(s), 0.1, cfg); if (s.events.some(e => e.type === 'engage')) started = s.t; }
  assert.ok(started > tEsc + cj.cooldown.protect_s);
  const A = s.bodies.A;
  assert.equal(A.routOnce, false); assert.equal(A.shock, 0);
  assert.ok(M.moraleOf(A, cfg) > 95, `士气 ${M.moraleOf(A, cfg)}`); // 只打了 1 tick
});

test('正式版：玩家兵力归零 → player-wiped（不再保留 5 兵），combat-end 带 wiped', () => {
  const P = team('P', { soldiers: 3, is_player: true, faction: 'player' });
  let s = world([[P, 0, 0], [team('B', { soldiers: 120, generals: [gen('gb', 60, 60)] }), 0, 0, Math.PI]]); touch(s, 'P', 'B');
  const evs = [];
  for (let i = 0; i < 400 && !evs.some(e => e.type === 'player-wiped'); i++) { if (s.bodies.P.foes.length) touch(s, 'P', 'B'); s = M.step(s, stay(s), 0.1, cfg); evs.push(...s.events); } // 被堵住跑不掉
  const w = evs.find(e => e.type === 'player-wiped');
  assert.ok(w, '玩家被歼灭');
  const end = evs.find(e => e.type === 'combat-end' && e.id === 'P');
  assert.equal(end.soldiers, 0); assert.equal(end.wiped, true); assert.equal(end.endKind, 'player-wiped');
  assert.equal(s.bodies.P.N0, 0);
});

test('v0.6 守城队死守：mem.noRetreat 时打不过也不撤（retreat_by_personality 不生效）', () => {
  const mk = () => { const s = world([[team('W', { soldiers: 20 }), 0, 0], [team('S', { soldiers: 120, generals: [gen('gs', 80, 80)] }), 0, 0]]); touch(s, 'W', 'S'); s.bodies.W.foes = ['S']; s.bodies.S.foes = ['W']; s.bodies.W.raw = 0.9; return s; };
  const a = combatIntent(mk().bodies.W, mk(), newCombatMem(), cfg, 'normal', 0.1);
  const s = mk(), mem = { ...newCombatMem(), noRetreat: true };
  const b = combatIntent(s.bodies.W, s, mem, cfg, 'normal', 0.1);
  assert.equal(a.mode, 'retreat');
  assert.notEqual(b.mode, 'retreat');
});

test('v0.6 城内受保护的一对（env.noEngage）不开战、也不互相推挤', () => {
  let s = world([[team('A'), 0, 0], [team('B'), 0, 0]]);
  touch(s, 'A', 'B'); s.bodies.B.x = s.bodies.A.x + 4; // 大幅重叠
  const x0 = [s.bodies.A.x, s.bodies.B.x];
  for (let i = 0; i < 5; i++) s = M.step(s, stay(s), 0.1, cfg, { noEngage: () => true });
  assert.equal(Object.keys(s.pairs).length, 0);
  assert.deepEqual([s.bodies.A.x, s.bodies.B.x], x0);
  // 对照：没有保护 → 开战
  let s2 = world([[team('A'), 0, 0], [team('B'), 0, 0]]); touch(s2, 'A', 'B');
  for (let i = 0; i < 5; i++) s2 = M.step(s2, stay(s2), 0.1, cfg);
  assert.equal(Object.keys(s2.pairs).length, 1);
});
