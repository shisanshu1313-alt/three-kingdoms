import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pullCost, oddsTable, canPull, pull, applyAttrUpgrade, attrTargets, resolveItemFull, freeByTier, weightedPick } from '../src/systems/gacha.js';
import { createGameState } from '../src/systems/gameState.js';
import { indexBalance } from '../src/systems/teams.js';
import { mulberry32 } from '../src/systems/rng.js';

const balance = JSON.parse(readFileSync(new URL('../src/data/balance.json', import.meta.url)));
const idx = indexBalance(balance);
const G = id => ({ ...idx.generalsById[id] });
const hero = () => ({ ...balance.hero });
const player = (over = {}) => ({ id: 'player', faction: 'player', is_player: true, soldiers: 30, generals: [hero()], items: ['war_drum'], ...over });
const state = (points = 1e6) => { const s = createGameState(balance); s.points = points; return s; };
/** 指定 rng 序列；用完后回落到 0.5 */
const seq = (...v) => { let i = 0; return () => (i < v.length ? v[i++] : 0.5); };
const POOL = balance.gacha.pool, TOTAL = POOL.reduce((s, e) => s + e.weight, 0);
const rollFor = type => { let acc = 0; for (const e of POOL) { if (e.type === type) return (acc + e.weight / 2) / TOTAL; acc += e.weight; } };

test('单价 = min(cost_base + cost_step × 已抽次数, cost_cap)', () => {
  const g = balance.gacha;
  assert.equal(pullCost(0, g), 50); assert.equal(pullCost(1, g), 55); assert.equal(pullCost(10, g), 100);
  assert.equal(pullCost(1000, g), g.cost_cap);
});

test('概率表来自配置权重', () => {
  const t = oddsTable(balance.gacha);
  assert.deepEqual(t.map(r => r.type), POOL.map(e => e.type));
  assert.ok(Math.abs(t.reduce((s, r) => s + r.p, 0) - 1) < 1e-12);
  assert.equal(t.find(r => r.type === 'general_S').p, 1 / TOTAL);
});

test('点数不足 / 战斗中 / 有待安排武将 → 不能抽，且不扣点', () => {
  const s = state(49), t = player();
  const c = canPull(s, t, balance);
  assert.equal(c.ok, false); assert.equal(c.reason, 'points');
  assert.equal(c.text, '点数不足：下一抽需要 50 点，还差 1 点');
  assert.throws(() => pull(s, t, balance, Math.random));
  assert.equal(s.points, 49); assert.equal(s.gachaDraws, 0);
  assert.equal(canPull(state(), t, balance, { inBattle: true }).reason, 'battle');
  const p = state(); p.pendingGenerals.push({ general: G('lvbu'), source: 'capture' });
  assert.equal(canPull(p, t, balance).reason, 'pending');
});

test('先扣点并次数+1，再出结果', () => {
  const s = state(100), t = player();
  pull(s, t, balance, seq(rollFor('item'), 0.99)); // 物品
  assert.equal(s.gachaDraws, 1);
  assert.ok(s.points === 50 || s.points === 75); // 75 = 抽到已拥有物品返还 25
});

test('确定性：同种子同结果序列', () => {
  const run = () => {
    const s = state(), t = player(), rng = mulberry32(42), out = [];
    for (let i = 0; i < 30; i++) {
      const r = pull(s, t, balance, rng);
      out.push([r.type, r.general?.id, r.item?.id, r.attr?.attr]);
      if (r.next === 'choose_general') applyAttrUpgrade(t, r.targets[0], r.amount, balance, rng);
      if (r.next === 'item_full') resolveItemFull(s, t, r.item, null, balance);
      if (r.next === 'roster_full') s.pendingGenerals.length = 0;
    }
    return { out, points: s.points, pool: s.freePool };
  };
  assert.deepEqual(run(), run());
});

test('分布合理：20 万次按权重抽类型（±1%）', () => {
  const rng = mulberry32(7), N = 200000, cnt = {};
  for (let i = 0; i < N; i++) { const e = weightedPick(POOL, rng); cnt[e.type] = (cnt[e.type] || 0) + 1; }
  for (const e of POOL) assert.ok(Math.abs(cnt[e.type] / N - e.weight / TOTAL) < 0.01, `${e.type} ${cnt[e.type] / N}`);
});

test('武将：只从自由池对应档位出，移出自由池；未满 3 将直接入队', () => {
  const s = state(), t = player();
  assert.deepEqual(freeByTier(s, balance, 'S'), ['zhugeliang']);
  const r = pull(s, t, balance, seq(rollFor('general_S'), 0));
  assert.equal(r.type, 'general_S'); assert.equal(r.general.id, 'zhugeliang');
  assert.ok(!s.freePool.includes('zhugeliang'));
  assert.equal(t.generals[1].id, 'zhugeliang');
  assert.equal(r.text, '诸葛亮（S）加入队伍');
});

test('武将：该档自由池为空 → 改出 attr_big', () => {
  const s = state(), t = player();
  s.freePool = s.freePool.filter(id => idx.generalsById[id].tier !== 'B'); // 初始自由池本来就没有 B
  const r = pull(s, t, balance, seq(rollFor('general_B'), 0));
  assert.equal(r.fallback, 'attr_big'); assert.equal(r.type, 'attr_big');
  assert.equal(r.attr.new - r.attr.old, 5); // 只有主角一人 → 自动选中
});

test('武将：满 3 将进入 pending_generals（source=gacha）', () => {
  const s = state(), t = player({ generals: [hero(), G('liaohua'), G('huaxiong')] });
  const r = pull(s, t, balance, seq(rollFor('general_A'), 0));
  assert.equal(r.next, 'roster_full');
  assert.equal(t.generals.length, 3);
  assert.equal(s.pendingGenerals[0].source, 'gacha');
  assert.equal(r.text, `${r.general.name}（A）待安排：队伍已满`);
});

test('属性：多名可选 → 选人；未满属性中等概率；截断到 100；全满武将不可选', () => {
  const s = state(), t = player({ generals: [hero(), { ...G('lvbu'), str: 99 }] });
  const r = pull(s, t, balance, seq(rollFor('attr_big')));
  assert.equal(r.next, 'choose_general'); assert.deepEqual(r.targets, [0, 1]);
  const up = applyAttrUpgrade(t, 1, 5, balance, () => 0.26); // open = [lead,str,int,cha] → idx1 = str
  assert.equal(up.attr, 'str'); assert.equal(up.new, 100); assert.equal(up.text, '吕布 武力 99 → 100');
  const full = { ...G('lvbu'), lead: 100, str: 100, int: 100, cha: 100 };
  assert.deepEqual(attrTargets(player({ generals: [hero(), full] }), balance), [0]);
  const g2 = { ...hero(), lead: 100, str: 100, int: 100 };
  const t2 = player({ generals: [g2] });
  for (let i = 0; i < 5; i++) assert.equal(applyAttrUpgrade(t2, 0, 2, balance, Math.random).attr, 'cha');
});

test('属性：全队四项全满 → 返还 duplicate_item_refund_points', () => {
  const s = state(1000), t = player({ generals: [{ ...hero(), lead: 100, str: 100, int: 100, cha: 100 }] });
  const r = pull(s, t, balance, seq(rollFor('attr_small')));
  assert.equal(r.refund, balance.gacha.duplicate_item_refund_points);
  assert.equal(s.points, 1000 - 50 + 25);
});

test('物品：空栏直接放入；重复返还；满栏可丢旧换新或放弃（返还）', () => {
  const items = balance.items, iOf = id => items.findIndex(i => i.id === id);
  const pickItem = id => (iOf(id) + 0.5) / items.length;
  let s = state(), t = player();
  let r = pull(s, t, balance, seq(rollFor('item'), pickItem('fine_horse')));
  assert.deepEqual(t.items, ['war_drum', 'fine_horse']); assert.equal(r.text, '获得 良马：速度 +15%');
  r = pull(s, t, balance, seq(rollFor('item'), pickItem('war_drum')));
  assert.equal(r.refund, 25); assert.equal(r.text, '已拥有 战鼓，返还 25 点');
  t.items.push('banner');
  r = pull(s, t, balance, seq(rollFor('item'), pickItem('art_of_war')));
  assert.equal(r.next, 'item_full');
  const before = s.points;
  const keep = resolveItemFull(s, t, r.item, null, balance);
  assert.equal(keep.refund, 25); assert.equal(s.points, before + 25); assert.equal(t.items.length, 3);
  resolveItemFull(s, t, r.item, 1, balance);
  assert.deepEqual(t.items, ['war_drum', 'art_of_war', 'banner']);
});
