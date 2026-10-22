// v0.5 一局：配置覆盖 / 章节 / 克制 × 章节 / 偏好兵种 / 克制物品 / 追击规则 / 失败 B / 胜利 / 名望 / 局外解锁 / 删档
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as M from '../src/systems/melee.js';
import { applyRunConfig, chapterIndexAt, spawnPowerRange, counterAddOf, counterOf } from '../src/systems/runConfig.js';
import { createRun, runTick, checkFail, heroDamage, onPlayerBattleEnd, onNamedDefeated, runSummary, recordUnit, unitAt, targetUnitFor } from '../src/systems/run.js';
import { createMeta, applyRunResult, startOptions, parseMeta, loadMeta, saveMeta } from '../src/systems/meta.js';
import { pickBanditUnit } from '../src/systems/units.js';
import { affinityBonus, computePower } from '../src/systems/combat.js';
import { buildRespawnTeam, indexBalance, createNameAllocator } from '../src/systems/teams.js';
import { decide } from '../src/systems/aiBrain.js';
import AISystem from '../src/systems/ai.js';
import { mulberry32 } from '../src/systems/rng.js';
import { MemoryStorageAdapter } from '../src/platform/storage.js';
import { SAVE_KEY, META_KEY, clearSave, hasSave, writeSave } from '../src/systems/save.js';

const J = f => JSON.parse(readFileSync(new URL(f, import.meta.url)));
const b04 = J('../src/data/balance.json'), cfg = J('../src/data/run_v05.json'), cj = J('../src/data/combat_v05.json');
const design = J('../../design/balance_v0.5.json');
const balance = applyRunConfig(b04, cfg);
const mc = { ...M.makeCombatConfig(cj, balance), fixedRoll: 1 };

test('配置：run_v05.json 与 balance_v0.5.json 一致（章节 / 开局 / 失败 / 局外 / 存档键）', () => {
  const fp = design.fast_pace;
  assert.equal(cfg.duration_min, 20);
  assert.deepEqual(cfg.chapters.map(c => c.start_s), [0, 240, 540, 840]);
  assert.deepEqual(cfg.chapters.map(c => c.counter_mult), [1.0, 1.1, 1.25, 1.45]);
  assert.deepEqual(cj.move.counter_mult_by_chapter, [1.0, 1.1, 1.25, 1.45]);
  assert.equal(cfg.first_battle.at_s, 20); assert.equal(cfg.grace_s, 90);
  assert.deepEqual(cfg.first_battle.power_vs_player, [0.6, 0.8]); assert.deepEqual(cfg.first_battle.dist_px, [350, 450]);
  assert.ok(fp, 'fast_pace 存在');
  assert.equal(cfg.failure.hero_hp_max, 100); assert.equal(cfg.failure.recruit_floor, 40);
  assert.deepEqual(cfg.save.keys, { run: 'sanguo-run-v1', meta: 'sanguo-meta-v1', legacy_from: 'sanguo-save', legacy_to: 'sanguo-save-legacy' });
  assert.equal(SAVE_KEY, 'sanguo-run-v1'); assert.equal(META_KEY, 'sanguo-meta-v1');
  assert.equal(cfg.run_goal.named.length, 4);
});

test('覆盖层：1600 px 地图、城池布局、密度、成长调参、克制物品并入物品表；不改 v0.4 原数据', () => {
  assert.equal(balance.map.width_px, 1600); assert.equal(balance.map.tiles_w, 50);
  const ly = balance.cities.find(c => c.id === 'luoyang');
  assert.deepEqual(ly.tile, { x: Math.floor(816 / 32), y: Math.floor(560 / 32) });
  assert.deepEqual(balance.player_faction.start, ly.px);
  assert.equal(balance.spawn.max_ai_teams, 10); assert.equal(balance.spawn.respawn_interval_s, 12); assert.deepEqual(balance.spawn.dist_from_player_px, [400, 800]);
  assert.equal(balance.ai.vision_px, 300);
  assert.equal(balance.gacha.cost_cap, 90);
  for (const id of ['juma', 'tengjia', 'zhongkai', 'scout_flag']) assert.ok(balance.items.some(i => i.id === id), id);
  assert.equal(b04.map.width_px, 3200, 'v0.4 原数据不变');
  for (const t of balance.initial_teams.filter(t => typeof t.position === 'object' && t.faction !== b04.player_faction.id)) {
    const d = Math.hypot(t.position.x - balance.player_faction.start.x, t.position.y - balance.player_faction.start.y);
    assert.ok(d >= cfg.density.spawn_dist_px[0] - 1, `${t.id} 离出生点 ${d}`);
  }
  for (const t of balance.initial_teams.filter(t => typeof t.position === 'object')) assert.ok(t.position.x <= 1600 && t.position.y <= 1600, t.id);
});

test('章节：按局内时间 0/4/9/14 分钟换章；runTick 只在边界发一次换章事件', () => {
  assert.deepEqual([0, 239.9, 240, 539, 540, 839, 840, 1200].map(t => chapterIndexAt(t, cfg)), [0, 0, 1, 1, 2, 2, 3, 3]);
  const r = createRun({ runId: 'r', runSeed: 1, cfg });
  const p = { soldiers: 50, cap: 100, power: 100, inBattle: true, inCity: false };
  const evs = [];
  for (let t = 0; t <= 900; t += 0.5) evs.push(...runTick(r, t, 0.5, p, cfg).filter(e => e.type === 'chapter'));
  assert.deepEqual(evs.map(e => e.idx), [1, 2, 3]);
  assert.equal(r.chapter, 3); assert.equal(r.maxChapter, 3);
});

test('章节缩放：刷新战力区间按章（群雄模式 +0.1），buildRespawnTeam 用这个区间', () => {
  assert.deepEqual(spawnPowerRange(0, cfg), [0.4, 0.9]);
  assert.deepEqual(spawnPowerRange(3, cfg), [0.7, 1.3]);
  const [lo, hi] = spawnPowerRange(3, cfg, true); assert.ok(Math.abs(lo - 0.8) < 1e-9 && Math.abs(hi - 1.4) < 1e-9);
  assert.equal(counterAddOf(cfg, true), 0.05); assert.equal(counterAddOf(cfg, false), 0);
  const idx = indexBalance(balance), rng = mulberry32(5), names = createNameAllocator(balance, rng);
  for (let i = 0; i < 30; i++) {
    const t = buildRespawnTeam({ id: `s${i}`, position: { x: 100, y: 100 }, playerPower: 200, powerRange: [0.7, 1.3], balance, rng, idx, nextName: names });
    assert.ok(t.targetPower >= 0.7 * 200 - 1e-6 && t.targetPower <= 1.3 * 200 + 1e-6, `target ${t.targetPower}`);
  }
});

test('黄巾兵种：第 1 章 70% 步兵；第 3/4 章按比例针对“克制玩家 60 s 前兵种”的兵种', () => {
  const rng = mulberry32(9), N = 4000, count = (mix, tgt) => { const c = {}; for (let i = 0; i < N; i++) { const u = pickBanditUnit(mix, rng, tgt); c[u] = (c[u] ?? 0) + 1; } return c; };
  const c1 = count(cfg.chapters[0].bandit_units, null);
  assert.ok(Math.abs(c1.inf / N - (0.7 + 0.3 / 4)) < 0.03, `inf ${c1.inf / N}`);
  const r = createRun({ runId: 'r', runSeed: 1, startUnit: 'inf', cfg });
  recordUnit(r, 100, 'cav');
  assert.equal(unitAt(r, 99), 'inf'); assert.equal(unitAt(r, 100), 'cav');
  // 玩家 100 s 起改骑兵；120 s 时看的是 60 s 时的兵种（步兵）→ 克步兵的是弓兵；170 s 时 → 克骑兵的是枪兵
  assert.equal(counterOf('inf', cj.move.counters), 'arc');
  assert.equal(targetUnitFor(r, 120, cfg, cj.move.counters), 'arc');
  assert.equal(targetUnitFor(r, 170, cfg, cj.move.counters), 'spr');
  const c4 = count(cfg.chapters[3].bandit_units, 'spr');
  assert.ok(Math.abs(c4.spr / N - (cfg.chapters[3].bandit_units.target + cfg.chapters[3].bandit_units.uniform / 4)) < 0.03, `spr ${c4.spr / N}`);
});

test('克制 × 章节倍率：1.0/1.1/1.25/1.45；群雄模式 +0.05；操练每级 +0.05', () => {
  const mk = (unit, over = {}) => M.makeBody({ id: unit, faction: unit, unit, soldiers: 50, generals: [{ id: 'g', name: 'g', lead: 40, str: 40, int: 20, cha: 20, generic: true }], items: [], position: { x: 0, y: 0 }, ...over }, balance, mc);
  const spr = mk('spr'), cav = mk('cav');
  const base = M.effPower(spr, cav, mc, 0) / M.powerOf(spr);
  [1.0, 1.1, 1.25, 1.45].forEach((k, ch) => assert.ok(Math.abs(M.effPower(spr, cav, mc, ch) / M.powerOf(spr) / base - k) < 1e-9, `ch${ch}`));
  assert.ok(Math.abs(M.effPower(cav, spr, mc, 3) - M.effPower(cav, spr, mc, 0)) < 1e-9, '被克方不加成');
  const hard = { ...mc, counterAdd: 0.05 };
  assert.ok(Math.abs(M.effPower(spr, cav, hard, 0) / M.powerOf(spr) / base - 1.05) < 1e-9);
  const drilled = mk('spr', { drill: 2 });
  assert.ok(Math.abs(M.effPower(drilled, cav, mc, 0) / M.powerOf(drilled) / base - 1.1) < 1e-9);
});

test('武将偏好兵种：主将偏好 = 队伍兵种 → M +0.10；不符 / 主角无偏好 → 0', () => {
  const team = (unit, gid) => ({ id: 't', faction: 'shu', unit, soldiers: 50, generals: [{ ...balance.generals.find(g => g.id === gid) }], items: [] });
  assert.equal(affinityBonus(team('spr', 'guanyu'), balance), 0.1);
  assert.equal(affinityBonus(team('cav', 'guanyu'), balance), 0);
  assert.equal(affinityBonus(team('inf', 'guanyu'), b04), 0, 'v0.4 配置没有偏好');
  assert.ok(computePower(team('spr', 'guanyu'), balance) > computePower(team('cav', 'guanyu'), balance));
});

test('克制物品：拒马 受骑兵伤害 −25% 且抵消冲锋；藤甲 / 重铠 同理（数据驱动）', () => {
  const mk = (id, unit, items = [], x = 0) => M.makeBody({ id, faction: id, unit, soldiers: 60, generals: [{ id: 'g' + id, name: id, lead: 40, str: 40, int: 20, cha: 20, generic: true }], items, position: { x, y: 0 } }, balance, mc, { h: x ? Math.PI : 0 });
  const D = mk('D', 'inf', ['juma']);
  assert.equal(D.stats.takenFrom.cav, 0.25); assert.deepEqual(D.stats.noCharge, ['cav']);
  assert.equal(M.takenMult(D, { unit: 'cav' }), 0.75); assert.equal(M.takenMult(D, { unit: 'arc' }), 1);
  assert.equal(mk('E', 'inf', ['tengjia']).stats.takenFrom.arc, 0.25);
  assert.equal(mk('F', 'inf', ['zhongkai']).stats.takenFrom.spr, 0.25);
  // 骑兵高速撞上：有拒马 → 无冲击、持续伤害 ×0.75
  const fight = (items) => {
    let s = M.createCombatState({ seed: 3 });
    const A = mk('A', 'cav'), B = mk('B', 'inf', items, 1);
    M.addBody(s, A); M.addBody(s, B);
    const d = M.radiusOf(60, mc) * 2 - 2; s.bodies.B.x = d; s.bodies.A.v = M.vmaxOf(s.bodies.A, mc);
    const evs = [];
    for (let i = 0; i < 20; i++) { s = M.step(s, { A: { h: 0, v: M.vmaxOf(s.bodies.A, mc) }, B: { h: Math.PI, v: 0 } }, 0.1, mc); evs.push(...s.events); }
    return { raw: s.bodies.B.raw, impact: evs.some(e => e.type === 'impact' && e.on === 'B') };
  };
  const plain = fight([]), guarded = fight(['juma']);
  assert.ok(plain.impact, '无拒马：被冲击'); assert.ok(!guarded.impact, '拒马：抵消冲锋');
  assert.ok(guarded.raw < plain.raw * 0.8, `拒马减伤 ${guarded.raw} vs ${plain.raw}`);
});

test('追击规则：开局 90 s 内不追玩家（来袭队除外）；名将军 1–2 章坐镇，3 章起只追 home 420 px 内', () => {
  const ai = new AISystem(balance);
  ai.rules = { graceUntilS: 90, namedIds: new Set(['wei_caocao']), namedLeashPx: null };
  const pl = { isPlayer: true, x: 500, y: 500 }, bandit = { team: { home: { x: 0, y: 0 } }, id: 'b1' }, named = { id: 'wei_caocao', team: { home: { x: 500, y: 900 } } };
  assert.equal(ai.canChaseFn(bandit, 10)(pl), false);
  assert.equal(ai.canChaseFn(bandit, 95)(pl), true);
  assert.equal(ai.canChaseFn({ ...bandit, team: { ...bandit.team, raid: true } }, 10)(pl), true, '来袭队无视新手保护');
  assert.equal(ai.canChaseFn(named, 200)(pl), false, '1–2 章坐镇');
  ai.rules.namedLeashPx = 420;
  assert.equal(ai.canChaseFn(named, 600)(pl), true, '目标距 home 400 ≤ 420');
  assert.equal(ai.canChaseFn(named, 600)({ ...pl, y: 300 }), false, '目标距 home 600 > 420');
  // decide 用 canChase：不能追就不进入 chase
  const self = { id: 'b1', faction: 'bandit', power: 300, x: 450, y: 500, home: { x: 0, y: 0 } };
  const others = [{ id: 'player', faction: 'player', power: 100, x: 500, y: 500, isPlayer: true, valid: true, inBattle: false }];
  const base = { self, others, mem: { state: 'wander', ignore: {}, since: 0 }, cfg: balance.ai, personality: 'aggressive', now: 10 };
  const yes = decide(base), no = decide({ ...base, canChase: () => false });
  if (yes.state === 'chase') assert.notEqual(no.state, 'chase');
});

test('失败规则 B：每场扣 HP = 35×阵亡比例（非胜）+ 20（溃逃）+ 5×撤退失败；兵 0 或 HP 0 → 失败', () => {
  assert.equal(heroDamage({ endKind: 'defeat', start: 50, lost: 20, routed: false, escFails: 0 }, cfg), 0, '胜利不扣阵亡');
  assert.equal(heroDamage({ endKind: 'escape', start: 50, lost: 20, routed: true, escFails: 2 }, cfg), 35 * 0.4 + 20 + 10);
  assert.equal(heroDamage({ endKind: 'defeat', wiped: true, start: 50, lost: 50, routed: false, escFails: 0 }, cfg), 35, '全灭不算胜');
  const r = createRun({ runId: 'r', runSeed: 1, cfg });
  onPlayerBattleEnd(r, { endKind: 'escape', start: 40, lost: 40, routed: true, escFails: 9 }, 30, cfg);
  assert.equal(r.heroHp, 100 - 35 - 20 - 45);
  assert.deepEqual(checkFail(r, 10, 30), { type: 'fail', reason: 'hero_hp' });
  assert.equal(r.over.result, 'defeat');
  const r2 = createRun({ runId: 'r2', runSeed: 1, cfg });
  assert.equal(checkFail(r2, 1, 5), null);
  assert.deepEqual(checkFail(r2, 0, 5), { type: 'fail', reason: 'soldiers' });
  assert.equal(checkFail(r2, 0, 6), null, '只结束一次');
});

test('回血 / 征兵：战后 5 s 内不回；脱战 10/分钟；城内 2/s；兵 < 40 在城内每 2 s +1', () => {
  const r = createRun({ runId: 'r', runSeed: 1, cfg }); r.heroHp = 50; r.lastBattleEndS = 100;
  const p = (over) => ({ soldiers: 30, cap: 100, power: 50, inBattle: false, inCity: false, ...over });
  runTick(r, 103, 1, p(), cfg); assert.equal(r.heroHp, 50, '5 s 内不回');
  runTick(r, 106, 6, p(), cfg); assert.ok(Math.abs(r.heroHp - 51) < 1e-9, '10/min');
  runTick(r, 107, 1, p({ inBattle: true }), cfg); assert.ok(Math.abs(r.heroHp - 51) < 1e-9, '战斗中不回');
  let rec = 0;
  for (let t = 110; t < 120; t += 0.1) for (const e of runTick(r, t, 0.1, p({ inCity: true }), cfg)) if (e.type === 'recruit') rec += e.n;
  assert.ok(r.heroHp > 70, `城内 2/s → ${r.heroHp}`);
  assert.ok(rec >= 4 && rec <= 5, `10 s 征兵 ${rec}`);
  rec = 0;
  for (let t = 120; t < 130; t += 0.1) for (const e of runTick(r, t, 0.1, p({ inCity: true, soldiers: 40 }), cfg)) if (e.type === 'recruit') rec++;
  assert.equal(rec, 0, '兵 ≥ 40 不征兵');
});

test('开局遭遇战：20 s 时发一次 raid 事件', () => {
  const r = createRun({ runId: 'r', runSeed: 1, cfg }), p = { soldiers: 30, cap: 100, power: 50, inBattle: false, inCity: false };
  const at = [];
  for (let t = 0; t < 40; t += 0.1) if (runTick(r, t, 0.1, p, cfg).some(e => e.type === 'raid')) at.push(t);
  assert.equal(at.length, 1); assert.ok(Math.abs(at[0] - 20) < 0.11);
});

test('胜利：4 路名将军都被击败（玩家有伤害份额）→ victory；没有份额 / 重复不算', () => {
  const r = createRun({ runId: 'r', runSeed: 1, cfg }), N = cfg.run_goal.named;
  assert.equal(onNamedDefeated(r, N[0], 0, 100, cfg), null, 'AI 互殴不算');
  assert.equal(onNamedDefeated(r, 'bandit_1', 1, 100, cfg), null);
  assert.equal(onNamedDefeated(r, N[0], 0.4, 100, cfg).left, 3);
  assert.equal(onNamedDefeated(r, N[0], 1, 101, cfg), null, '重复');
  onNamedDefeated(r, N[1], 1, 200, cfg); onNamedDefeated(r, N[2], 1, 300, cfg);
  assert.deepEqual(onNamedDefeated(r, N[3], 0.5, 400, cfg), { type: 'victory' });
  assert.equal(r.over.result, 'victory');
});

test('名望 = round(存活分钟×2 + 名将×50 + 最高战力/10)', () => {
  const r = createRun({ runId: 'r', runSeed: 7, cfg }); r.namedDefeated = ['wu_zhouyu']; r.maxPower = 333; r.maxChapter = 1;
  r.over = { result: 'defeat', reason: 'soldiers', atS: 600 };
  const s = runSummary(r, 600, cfg);
  assert.equal(s.fame, Math.round(10 * 2 + 50 + 33.3));
  assert.equal(s.chapterReached, 2); assert.equal(s.result, 'defeat'); assert.equal(s.runSeed, 7);
});

test('局外数据：只记解锁（无永久数值）；按 runId 去重；条件：到第 2 章 / 击败周瑜 / 名望 300 / 600 / 首通', () => {
  const sum = (o) => ({ runId: 'a', runSeed: 1, result: 'defeat', reason: 'soldiers', survivedS: 300, chapterReached: 2, namedDefeated: [], maxPower: 100, battles: 3, battlesWon: 1, fame: 100, hard: false, ...o });
  let { meta, newUnlocks } = applyRunResult(createMeta(), sum(), cfg);
  assert.deepEqual(newUnlocks.map(u => u.id), ['start_spr']);
  const dup = applyRunResult(meta, sum(), cfg);
  assert.equal(dup.duplicate, true); assert.equal(dup.meta.fameTotal, 100, '同一 runId 不重复累计');
  ({ meta, newUnlocks } = applyRunResult(meta, sum({ runId: 'b', namedDefeated: ['wu_zhouyu'], fame: 250 }), cfg));
  assert.deepEqual(newUnlocks.map(u => u.id).sort(), ['start_arc', 'start_liaohua']);
  ({ meta, newUnlocks } = applyRunResult(meta, sum({ runId: 'c', result: 'victory', fame: 300, namedDefeated: ['qun_lvbu'] }), cfg));
  assert.deepEqual(newUnlocks.map(u => u.id).sort(), ['hard_mode', 'start_cav', 'start_item']);
  assert.equal(meta.fameTotal, 650); assert.equal(meta.clears, 1);
  const o = startOptions(meta, cfg);
  assert.deepEqual(o.units, ['inf', 'spr', 'arc', 'cav']); assert.deepEqual(o.generals, ['liaohua']);
  assert.deepEqual(o.items, ['war_drum', 'fine_horse', 'art_of_war', 'banner']); assert.equal(o.hard, true);
  assert.deepEqual(startOptions(createMeta(), cfg), { units: ['inf'], generals: [], items: ['war_drum'], hard: false });
  for (const k of Object.keys(meta)) assert.ok(!/attr|lead|str|power_bonus|soldier/.test(k), `没有永久数值字段：${k}`);
  // 存储往返 / 坏数据
  const st = new MemoryStorageAdapter();
  saveMeta(st, META_KEY, meta);
  assert.deepEqual(loadMeta(st, META_KEY), meta);
  assert.deepEqual(parseMeta('{bad'), createMeta()); assert.deepEqual(parseMeta('{"version":99}'), createMeta());
});

test('删档：死亡时先删 run 存档再写局外数据（两个键互不影响）', () => {
  const st = new MemoryStorageAdapter();
  writeSave({ saveVersion: 4, run: { runId: 'x' } }, st);
  saveMeta(st, META_KEY, createMeta());
  assert.ok(hasSave(st));
  clearSave(st);
  assert.equal(hasSave(st), false);
  assert.deepEqual(loadMeta(st, META_KEY), createMeta(), 'meta 不受删档影响');
  const r = createRun({ runId: 'x', runSeed: 1, cfg }); r.over = { result: 'defeat', reason: 'soldiers', atS: 60 };
  const { meta } = applyRunResult(loadMeta(st, META_KEY), runSummary(r, 60, cfg), cfg);
  saveMeta(st, META_KEY, meta);
  assert.equal(loadMeta(st, META_KEY).runs, 1); assert.equal(hasSave(st), false);
});

test('gacha_v05：卡池权重 44/13/22/10/5/0/5/1（= 策划 weights）；item_source 规范化；抽卡价 min(30+3n, 90)（= gacha_v05.cost）', async () => {
  const { oddsTable, pullCost } = await import('../src/systems/gacha.js');
  assert.deepEqual(balance.gacha.pool.map(e => [e.type, e.weight]), [['attr_small', 44], ['attr_big', 13], ['item', 22], ['unit_order', 10], ['drill', 5], ['general_B', 0], ['general_A', 5], ['general_S', 1]]);
  assert.deepEqual(Object.fromEntries(balance.gacha.pool.map(e => [e.type, e.weight])), design.gacha_v05.weights);
  assert.equal(design.gacha_v05.cost.replace(/\s/g, ''), `min(${balance.gacha.cost_base}+${balance.gacha.cost_step}n,${balance.gacha.cost_cap})`);
  assert.deepEqual([balance.gacha.cost_base, balance.gacha.cost_step, balance.gacha.cost_cap], [30, 3, 90]);
  assert.deepEqual(balance.gacha.pool.filter(e => e.attr_amount).map(e => e.attr_amount), [2, 5]);
  assert.equal(balance.gacha.pool.find(e => e.type === 'item').item_source, 'items_all_uniform');
  assert.ok(Math.abs(oddsTable(balance.gacha).reduce((s, e) => s + e.p, 0) - 1) < 1e-12);
  assert.deepEqual([0, 1, 10, 20, 30].map(n => pullCost(n, balance.gacha)), [30, 33, 60, 90, 90]);
});

test('gacha_v05：操练 +1 级（每局最多 3 次，满了改出属性卡）；兵种令 → 选择兵种 / 不改返还 25；换兵种清零操练', async () => {
  const G = await import('../src/systems/gacha.js');
  const { createGameState } = await import('../src/systems/gameState.js');
  const st = createGameState(balance); st.points = 10000;
  const hero = { id: 'hero', name: '主角', lead: 40, str: 45, int: 40, cha: 40 };
  const team = { id: 'player', is_player: true, unit: 'inf', soldiers: 30, generals: [hero], items: ['war_drum'] };
  const forced = (type) => { const i = balance.gacha.pool.findIndex(e => e.type === type), tot = balance.gacha.pool.reduce((s, e) => s + e.weight, 0);
    const before = balance.gacha.pool.slice(0, i).reduce((s, e) => s + e.weight, 0); const v = (before + 0.5) / tot; let k = 0; return () => (k++ === 0 ? v : 0.3); };
  for (let i = 1; i <= 3; i++) { const r = G.pull(st, team, balance, forced('drill')); assert.equal(r.type, 'drill'); assert.equal(team.drill, i); }
  const r4 = G.pull(st, team, balance, forced('drill'));
  assert.equal(r4.fallback, 'drill_max'); assert.equal(r4.type, 'attr_small'); assert.equal(team.drill, 3);
  const u = G.pull(st, team, balance, forced('unit_order'));
  assert.equal(u.next, 'choose_unit'); assert.equal(st.gachaPending.next, 'choose_unit');
  const pts = st.points;
  assert.deepEqual(G.resolveUnitOrder(st, team, 'inf', balance), { changed: false, refund: 25, unit: 'inf' });
  assert.equal(st.points, pts + 25); assert.equal(st.gachaPending, null); assert.equal(team.drill, 3, '不改兵种不清零');
  G.pull(st, team, balance, forced('unit_order'));
  assert.deepEqual(G.resolveUnitOrder(st, team, 'spr', balance), { changed: true, refund: 0, unit: 'spr' });
  assert.equal(team.unit, 'spr'); assert.equal(team.drill, 0, '换兵种清零');
  assert.throws(() => G.resolveUnitOrder(st, team, 'cav', balance));
});

test('侦察：≤300 精确兵数 + 对比色 + 克制箭头；≤500（斥候旗 +200）约数；更远不显示兵种', async () => {
  const { scoutInfo, scoutRange, SCOUT_COLORS } = await import('../src/systems/scouting.js');
  const counters = cj.move.counters;
  const range = scoutRange({ items: [] }, balance), flag = scoutRange({ items: ['scout_flag'] }, balance);
  assert.deepEqual(range, { vision: 300, scout: 500 }); assert.equal(flag.scout, 700);
  const me = { unit: 'spr', power: 100, soldiers: 40 }, them = { unit: 'cav', power: 110, soldiers: 47 };
  const v = scoutInfo({ me, them, dist: 250, range, counters, mult: 1.25 });
  assert.equal(v.tier, 'vision'); assert.equal(v.soldiers, '47'); assert.equal(v.arrow, '↑'); assert.equal(v.color, SCOUT_COLORS.even); // 100×1.25/110 = 1.14
  assert.equal(scoutInfo({ me, them: { ...them, power: 60 }, dist: 250, range, counters }).color, SCOUT_COLORS.good);
  assert.equal(scoutInfo({ me: { ...me, unit: 'arc' }, them, dist: 250, range, counters, mult: 1.45 }).arrow, '↓');
  const s = scoutInfo({ me, them, dist: 450, range, counters });
  assert.equal(s.tier, 'scout'); assert.equal(s.soldiers, '约50'); assert.equal(s.showUnit, true);
  assert.equal(scoutInfo({ me, them, dist: 600, range, counters }).showUnit, false);
  assert.equal(scoutInfo({ me, them, dist: 600, range: flag, counters }).tier, 'scout');
});

test('输入：同一个原生键盘事件被 Phaser 重复派发时只算一次（Phaser 3.90 队列重处理）', async () => {
  const { KeyboardSource, InputActions, ACTIONS } = await import('../src/platform/input.js');
  const handlers = [];
  const scene = { input: { keyboard: { addCapture() {}, addKey() { return { isDown: false }; }, on(ev, fn) { handlers.push(fn); }, off() {} } } };
  const acts = new InputActions(); acts.addSource(new KeyboardSource(scene));
  let n = 0; acts.on(ACTIONS.DEBUG_VISION, () => { n++; });
  const e1 = { key: 'F1', keyCode: 112, repeat: false }, e2 = { key: 'F1', keyCode: 112, repeat: false };
  handlers[0](e1); handlers[0](e1); handlers[0](e2); handlers[0](e1);
  assert.equal(n, 2, '两个不同的按键事件 → 2 次');
});

test('策划定稿清单 ↔ 程序配置：地图 / 密度 / 脱离 / 保护 / 背击 / 士气 / 弓兵 / HP / 城池 / 侦察 / 局外解锁', () => {
  assert.equal(balance.map.width_px, 1600); assert.equal(balance.map.height_px, 1600);
  assert.equal(balance.spawn.max_ai_teams, 10); assert.equal(balance.spawn.respawn_interval_s, 12);
  assert.equal(cj.move.escape_gap_px, 150); assert.equal(cj.move.escape_s, 2);
  assert.equal(cj.cooldown.protect_s, 8); assert.equal(cj.move.rear_mult, 1.3);
  assert.equal(cj.move.morale_rout, 30); assert.equal(cj.confirmed.player_rout_once_per_battle, true);
  assert.equal(cj.move.units.arc.range_px, 120); assert.equal(cj.move.units.arc.ammo_s, 12);
  const F = cfg.failure;
  assert.deepEqual([F.hero_hp_max, F.hero_hp_per_dead, F.hero_hp_rout, F.regen_out_of_battle_per_min, F.regen_in_city_per_s, F.recruit_floor, F.city_radius_px], [100, 35, 20, 10, 2, 40, 200]);
  assert.deepEqual([balance.v05.units.scouting.vision_px, balance.v05.units.scouting.scout_px], [300, 500]);
  assert.equal(cfg.named_reinforce.per_min, 3);
  assert.equal(balance.rewards.capture_rules.generic_capturable, false, '黄巾头目不可俘获');
  assert.equal(balance.ai.chase_max_ratio, 3);
  const u = Object.fromEntries(cfg.meta.unlocks.map(x => [x.id, x]));
  assert.deepEqual(['start_spr', 'start_arc', 'start_cav', 'start_liaohua', 'start_item', 'hard_mode'].map(k => !!u[k]), [true, true, true, true, true, true]);
  assert.deepEqual(u.hard_mode.cond, { cleared: true });
  assert.equal(u.start_liaohua.general, 'liaohua');
});

test('黄巾头目不可俘获（polish_merged.1）；名将照常可俘', async () => {
  const { isCapturable } = await import('../src/systems/combat.js');
  assert.equal(isCapturable({ id: 'b_gen', generic: true, lead: 30, str: 30, int: 30, cha: 30 }, balance), false);
  assert.equal(isCapturable(balance.generals.find(g => g.id === 'xiahoudun'), balance), true);
  assert.equal(isCapturable({ id: 'hero' }, balance), false);
});

