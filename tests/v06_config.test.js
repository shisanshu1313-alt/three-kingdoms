// v0.6 配置：src/data/v06.json 必须等于 scripts/sync-v06.mjs 对 tests/fixtures/balance_v0.6.json（策划定稿副本）的输出。npm test
// 单测不读工作区 design/（CI 里没有）；策划改版 → cp 到 tests/fixtures/ → npm run sync:v06 tests/fixtures/balance_v0.6.json
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildV06 } from '../scripts/sync-v06.mjs';

const J = f => JSON.parse(readFileSync(new URL(f, import.meta.url)));
const design = J('./fixtures/balance_v0.6.json'), v06 = J('../src/data/v06.json');

test('v06.json = sync-v06(fixtures/balance_v0.6.json)（忘记 npm run sync:v06 会失败）', () => {
  assert.deepEqual(v06, buildV06(design));
  assert.equal(design._meta.version, '0.6');
});

test('19 条决策全部按推荐定稿（confirmed_assumptions.answers = decisions[].recommend）', () => {
  assert.equal(Object.keys(v06.decisions).length, design.decisions_count);
  for (const d of design.decisions) assert.equal(v06.decisions[d.id], d.recommend, d.id);
});

test('关键数值从文字里取对：价格 / 刷新 / 兵力卡 / 统帅 / 名册 / 主城', () => {
  const g = v06.gacha, c = v06.city;
  assert.deepEqual(g.cost, { base: 50, step: 5, cap: 150 });
  assert.deepEqual(g.refresh, { free_per_chapter: 1, cost: 20, max_per_draw: 1 });
  assert.deepEqual(g.cards.troops_s, { rarity: 'common', min: 3, pct: 0.03 });
  assert.deepEqual(g.cards.troops_b, { rarity: 'rare', min: 6, pct: 0.08 });
  assert.equal(g.offer_size, 4); assert.equal(g.troops_illegal_ratio, 0.9); assert.equal(g.epic_stack_max, 2);
  assert.equal(v06.leader.sub_lead_k, 0.3); assert.deepEqual(v06.leader.hero_growth, { lead: 6, str: 4, cap: 100 });
  assert.equal(v06.leader.sub_affinity_bonus, 0.05); assert.equal(v06.leader.speed_L_cap, 100);
  assert.deepEqual(v06.roster, { max_generals: 3, storage_max: 3, swap_radius_px: 200, exile_points: 20 });
  assert.deepEqual(c.def_by_chapter, [230, 420, 700, 870]); assert.deepEqual(c.arrow_ref_power, [115, 166, 234, 249]);
  assert.equal(c.radius_px, 48); assert.equal(c.inside_px, 60); assert.equal(c.lost_def_ratio, 0.3);
});

test('配置文字被改动导致取不到数 → 同步脚本报错（不会静默用旧值）', () => {
  const bad = structuredClone(design); bad.gacha_v06.price.formula = 'cost = 很多';
  assert.throws(() => buildV06(bad), /price\.formula/);
});
