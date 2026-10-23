import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balance } from '../src/data/index.js';
import { createGameState } from '../src/systems/gameState.js';
import { mulberry32 } from '../src/systems/rng.js';
import { computePower, soldierCap } from '../src/systems/combat.js';
import { drawCost, canOpen, openDraw, genOffer, refreshInfo, refreshOffer, pickCard, makeCard, kindWeights, passesRules, previewCard, threatUnits, stackCount } from '../src/systems/gachaOffer.js';

const G6 = balance.v06.gacha;
const team = () => ({ id: 'player', is_player: true, soldiers: 60, unit: 'inf', drill: 0, generals: [{ ...balance.hero }], items: [] });
const st = (pts = 1000) => { const s = createGameState(balance); s.points = pts; return s; };

test('价格 min(50 + 5n, 150)，配置来自 v06', () => {
  assert.deepEqual([0, 1, 10, 20, 50].map(n => drawCost(n, balance)), [50, 55, 100, 150, 150]);
});

test('openDraw：扣点、n+1、4 张、规则（不重复 / 同类 ≤2 / 武将 ≤1 / 兵种令 ≤1 / 至少 1 张成长卡）', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const s = st(), t = team(), rng = mulberry32(seed);
    const o = openDraw(s, t, balance, rng, { chapter: seed % 4, threat: seed % 3 ? [] : ['spr'] });
    assert.equal(s.points, 950); assert.equal(s.gacha.n, 1); assert.equal(s.gachaDraws, 1);
    assert.equal(o.cards.length, G6.offer_size);
    const kinds = o.cards.map(c => c.kind);
    for (const k of new Set(kinds)) assert.ok(kinds.filter(x => x === k).length <= G6.max_same_kind, `seed ${seed}`);
    assert.ok(kinds.filter(k => k.startsWith('general_')).length <= 1);
    assert.ok(kinds.filter(k => k === 'unit_order').length <= 1);
    assert.ok(kinds.some(k => G6.growth_kinds.includes(k)), `seed ${seed} 没有成长卡 ${kinds}`);
    const keys = o.cards.map(c => c.kind + JSON.stringify(c.target ?? null));
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(new Set(o.cards.map(c => c.id)).size, 4);
    // 再开：offer 还在 → 不扣点，返回同一组
    assert.equal(openDraw(s, t, balance, rng), o); assert.equal(s.points, 950);
  }
});

test('稀有度分布 ≈ 87/12/1（每槽），每抽至少 1 张高阶 ≈ 3.94%', () => {
  const rng = mulberry32(7), cnt = { common: 0, rare: 0, epic: 0 };
  let epicDraw = 0; const N = 4000;
  for (let i = 0; i < N; i++) {
    const s = st(), t = team(); s.freePool = [...balance.initial_free_pool];
    const o = genOffer(s, t, balance, rng, { chapter: 0 });
    o.cards.forEach(c => cnt[c.rarity]++);
    if (o.hadEpic) epicDraw++;
  }
  const tot = N * 4;
  assert.ok(Math.abs(cnt.common / tot - 0.87) < 0.02, JSON.stringify(cnt));
  assert.ok(Math.abs(cnt.rare / tot - 0.12) < 0.02, JSON.stringify(cnt));
  assert.ok(Math.abs(epicDraw / N - 0.0394) < 0.012, `epic ${epicDraw / N}`);
});

test('不合法的卡不出：兵 ≥ 90% 上限不补兵；已有物品不出；操练 3 次后不出；空档位武将不出；高阶叠 2 次不出', () => {
  const s = st(), t = team(), rng = mulberry32(3);
  t.soldiers = Math.ceil(soldierCap(t, balance) * 0.9);
  assert.equal(makeCard('troops_s', s, t, balance, rng), null);
  t.soldiers = 10;
  const c = makeCard('troops_b', s, t, balance, rng);
  assert.equal(c.amount, Math.max(6, Math.round(0.08 * soldierCap(t, balance))));
  t.items = [...G6.cards.item.items];
  assert.equal(makeCard('item', s, t, balance, rng), null);
  s.drillUsed = 3; assert.equal(makeCard('drill', s, t, balance, rng), null);
  s.freePool = []; assert.equal(makeCard('general_S', s, t, balance, rng), null);
  t.epPower = 0.2; assert.equal(stackCount(t, balance, 'ep_power'), 2); assert.equal(makeCard('ep_power', s, t, balance, rng), null);
  t.epCounter = 0.1; assert.ok(makeCard('ep_counter', s, t, balance, rng));
  // offer 规则
  const a = { kind: 'attr_s', target: { generalId: 'hero', attr: 'str' } };
  assert.equal(passesRules({ ...a }, [a], balance), false);
  assert.equal(passesRules({ kind: 'unit_order' }, [{ kind: 'unit_order' }], balance), false);
});

test('克制卡权重：章节 ×1/1/1.5/2；视野内有克制我方的敌人时兵种令 ×2；克制物品对应那件 ×2', () => {
  assert.equal(kindWeights('common', balance, { chapter: 0 }).unit_order, 10);
  assert.equal(kindWeights('common', balance, { chapter: 3 }).drill, 12);
  assert.equal(kindWeights('common', balance, { chapter: 2, threat: ['cav'] }).unit_order, 30);
  assert.equal(kindWeights('common', balance, { chapter: 2 }).attr_s, 32);
  assert.deepEqual(threatUnits('inf', [{ unit: 'cav', dist: 400 }, { unit: 'spr', dist: 900 }, { unit: 'arc', dist: 100 }], 500, { cav: 'arc', spr: 'cav', arc: 'inf', inf: 'spr' }), ['arc']);
  const rng = mulberry32(11), s = st(), t = team(); let teng = 0;
  for (let i = 0; i < 3000; i++) if (makeCard('item_counter', s, t, balance, rng, { threat: ['arc'] }).target.itemId === 'tengjia') teng++;
  assert.ok(Math.abs(teng / 3000 - 0.5) < 0.04, String(teng)); // 2/(2+1+1)
});

test('刷新：每章首次免费、之后 20 点；每抽最多 1 次；不增加 n', () => {
  const s = st(200), t = team(), rng = mulberry32(5);
  openDraw(s, t, balance, rng, { chapter: 1 });
  assert.equal(s.points, 150);
  assert.deepEqual(refreshInfo(s, balance, 1).cost, 0);
  refreshOffer(s, t, balance, rng, { chapter: 1 });
  assert.equal(s.points, 150); assert.equal(s.gacha.n, 1); assert.equal(s.gacha.freeRefreshUsed[1], 1);
  assert.equal(refreshInfo(s, balance, 1).ok, false);
  pickCard(s, t, 0, balance, rng, { unit: 'spr', discard: 0 });
  openDraw(s, t, balance, rng, { chapter: 1 });
  const info = refreshInfo(s, balance, 1);
  assert.equal(info.cost, 20); assert.equal(info.ok, true);
  const p = s.points; refreshOffer(s, t, balance, rng, { chapter: 1 }); assert.equal(s.points, p - 20);
  assert.equal(s.gacha.n, 2);
});

test('结算：属性 / 补兵 / 高阶四张 / 武将卡（满编进待安排）/ 物品栏满先选丢弃 / 兵种令先选兵种', () => {
  const s = st(), t = team(), rng = mulberry32(9);
  const set = cards => { s.gacha.offer = { id: 'x', cards, refreshUsed: 0, hadEpic: cards.some(c => c.rarity === 'epic') }; };
  set([{ kind: 'attr_b', rarity: 'rare', target: { generalId: 'hero', attr: 'lead' }, amount: 5 }]);
  let r = pickCard(s, t, 0, balance, rng); assert.equal(t.generals[0].lead, 45); assert.equal(s.gacha.offer, null); assert.equal(s.gacha.sinceEpic, 1);
  set([{ kind: 'ep_attr', rarity: 'epic', amount: 6 }]); pickCard(s, t, 0, balance, rng);
  assert.equal(t.generals[0].lead, 51); assert.equal(t.generals[0].str, 51); assert.equal(s.gacha.sinceEpic, 0);
  set([{ kind: 'ep_troops', rarity: 'epic', amount: 30 }]); const cap0 = soldierCap(t, balance); pickCard(s, t, 0, balance, rng);
  assert.equal(t.capBonus, 30); assert.equal(t.soldiers, cap0 + 30);
  const p0 = computePower(t, balance);
  set([{ kind: 'ep_power', rarity: 'epic', amount: 0.1 }]); r = pickCard(s, t, 0, balance, rng);
  assert.ok(Math.abs(computePower(t, balance) - p0 - 0.1 * t.soldiers) < 1e-6); assert.ok(r.powerAfter > r.powerBefore);
  set([{ kind: 'ep_counter', rarity: 'epic', amount: 0.1 }]); pickCard(s, t, 0, balance, rng); assert.equal(t.epCounter, 0.1);
  t.soldiers = 10;
  set([{ kind: 'troops_s', rarity: 'common', amount: 9 }]); pickCard(s, t, 0, balance, rng); assert.equal(t.soldiers, 19);
  // 兵种令：没给兵种 → choose_unit 且 offer 保留；给了 → 换兵种（不返还）
  set([{ kind: 'unit_order', rarity: 'common' }]);
  assert.equal(pickCard(s, t, 0, balance, rng).next, 'choose_unit'); assert.ok(s.gacha.offer);
  const pts = s.points; pickCard(s, t, 0, balance, rng, { unit: 'cav' }); assert.equal(t.unit, 'cav'); assert.equal(s.points, pts);
  // 物品栏满
  t.items = ['war_drum', 'fine_horse', 'banner'];
  set([{ kind: 'item', rarity: 'common', target: { itemId: 'art_of_war' } }]);
  assert.equal(pickCard(s, t, 0, balance, rng).next, 'item_full'); assert.ok(s.gacha.offer);
  r = pickCard(s, t, 0, balance, rng, { discard: 1 }); assert.deepEqual(t.items, ['war_drum', 'art_of_war', 'banner']); assert.match(r.text, /丢弃 良马/);
  // 武将卡：未满入队、满编进 pendingGenerals
  s.freePool = ['zhaoyun', 'zhangfei', 'zhugeliang'];
  set([{ kind: 'general_A', rarity: 'rare', target: { generalId: 'zhaoyun' } }]);
  const pv = previewCard(t, s.gacha.offer.cards[0], balance, s); assert.equal(pv.text, '作为副将入队'); assert.ok(pv.powerAfter > pv.powerBefore);
  r = pickCard(s, t, 0, balance, rng); assert.equal(r.joined, true); assert.ok(!s.freePool.includes('zhaoyun'));
  set([{ kind: 'general_A', rarity: 'rare', target: { generalId: 'zhangfei' } }]); pickCard(s, t, 0, balance, rng);
  set([{ kind: 'general_S', rarity: 'epic', target: { generalId: 'zhugeliang' } }]);
  assert.equal(previewCard(t, s.gacha.offer.cards[0], balance, s).replace.length, 2);
  r = pickCard(s, t, 0, balance, rng, { atS: 12 }); assert.equal(r.next, 'roster_full'); assert.equal(s.pendingGenerals[0].createdAtGameS, 12);
});

test('不能开：战斗中 / 点数不足 / 有待安排武将；offer 未选完 → resume', () => {
  const s = st(10), t = team();
  assert.equal(canOpen(s, t, balance).reason, 'points');
  s.points = 100; assert.equal(canOpen(s, t, balance, { inBattle: true }).reason, 'battle');
  s.gacha.offer = { cards: [] }; assert.equal(canOpen(s, t, balance, { inBattle: true }).reason, 'resume');
});
