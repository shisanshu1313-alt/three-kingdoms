// HUD 属性面板数据（systems/statsView.js）：主角四维、主将、派生值（兵力上限 / 智力减伤 / 魅力收编率 / 战力 / 速度）与变化检测。npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as M from '../src/systems/melee.js';
import { balance } from '../src/data/index.js'; // 游戏实际配置（v0.4 + v0.5 + v0.6）
import { computePower, soldierCap, lossReduction } from '../src/systems/combat.js';
import { defeatResult } from '../src/systems/fieldBattle.js';
import { buildStatsView, flattenStats, changedKeys, fmtPct, recruitRate } from '../src/systems/statsView.js';

const J = f => JSON.parse(readFileSync(new URL(f, import.meta.url)));
const cfg = M.makeCombatConfig(J('../src/data/combat_v05.json'), balance);
const near = (a, b, msg = '') => assert.ok(Math.abs(a - b) < 1e-9, `${msg} ${a} != ${b}`);
const lib = id => { const g = balance.generals.find(x => x.id === id); return { id: g.id, name: g.name, tier: g.tier, lead: g.lead, str: g.str, int: g.int, cha: g.cha }; };
const hero = () => ({ ...balance.hero });
const team = (over = {}) => ({ id: 'player', is_player: true, unit: 'inf', soldiers: 30, generals: [hero()], items: ['war_drum'], position: { x: 0, y: 0 }, ...over });

test('开局队伍：主角四维、主将 = 主角、上限 / 减伤 / 收编 / 战力按配置公式', () => {
  const v = buildStatsView(team(), balance, cfg);
  assert.deepEqual([v.hero.lead, v.hero.str, v.hero.int, v.hero.cha], [40, 45, 40, 50]);
  assert.equal(v.main.id, 'hero'); assert.equal(v.main.lead, 40);
  assert.equal(v.cap.total, 100 + 2 * 40);                         // soldier_cap_base + per_lead × Σ统率
  near(v.lossRed.int, 0.003 * 40, '智力减伤');                     // k_int × 最高智力
  near(v.lossRed.total, 0.12 + 0.05, '总减伤（含步兵 red）');
  near(v.recruit.total, balance.rewards.recruit_base + balance.rewards.recruit_per_cha * 50, '收编率（v0.5 recruit_base）');
  near(v.power.mult, 1 + 0.005 * 40 + 0.002 * 45 + 0.08, '战力倍率');
  near(v.power.total, computePower(team(), balance));
  near(v.speed.leadMult, 1 + cfg.move.lead_speed_k * (40 - 50));
  near(v.speed.total, v.speed.base * cfg.move.units.inf.speed * v.speed.leadMult);
});

test('与战斗用公式一致：soldierCap / lossReduction / melee.teamStats.red / defeatResult 的收编', () => {
  const t = team({ generals: [hero(), lib('zhugeliang'), lib('zhangfei')], items: ['art_of_war', 'banner'] });
  const v = buildStatsView(t, balance, cfg);
  assert.equal(v.cap.total, soldierCap(t, balance));
  near(v.lossRed.team, lossReduction(t, balance));
  near(v.lossRed.total, M.teamStats(t, balance, cfg).red);
  // 战场收编：败方 100 人 → recruited = floor(100 × 收编率)
  const L = { id: 'x', soldiers: 100, generals: [{ id: 'g', name: 'g', lead: 1, str: 1, int: 1, cha: 1, generic: true }], items: [] };
  assert.equal(defeatResult(t, L, { R: 1, power0: 10, playerShare: 1 }, balance).recruited, Math.floor(100 * recruitRate(t, balance) + 1e-9));
});

test('上限截断：智力减伤 ≤ int_loss_reduction_cap，收编率 ≤ recruit_max，总减伤 ≤ total_cap', () => {
  const t = team({ generals: [hero(), lib('zhugeliang')], items: ['art_of_war', 'banner'] });
  const v = buildStatsView(t, balance, cfg);
  near(v.lossRed.int, 0.3); near(v.lossRed.team, 0.38); near(v.lossRed.total, 0.43);
  near(v.recruit.fromCha, balance.rewards.recruit_base + balance.rewards.recruit_per_cha * 92); near(v.recruit.total, balance.rewards.recruit_max);
  assert.equal(v.main.id, 'hero'); // v0.6：玩家统帅永远是主角
  assert.ok(v.generals.find(g => g.id === 'hero').isMain);
  assert.ok(v.generals.find(g => g.id === 'hero').isHero);
});

test('A4：副将擅长当前兵种时战力倍率 + sub_affinity_bonus（主角没有擅长兵种）', () => {
  const a = lib('zhangfei');
  const off = buildStatsView(team({ generals: [hero(), a], unit: 'inf' }), balance, cfg);
  const on = buildStatsView(team({ generals: [hero(), a], unit: 'cav' }), balance, cfg);
  assert.equal(on.affinity.active, true); assert.equal(on.affinity.by, '张飞'); assert.equal(off.affinity.active, false);
  near(on.power.mult - off.power.mult, balance.v06.leader.sub_affinity_bonus);
});

test('不传战斗配置：兵种相关项为 null，其余照算', () => {
  const v = buildStatsView(team(), balance);
  assert.equal(v.lossRed.unit, null); assert.equal(v.speed.total, null);
  near(v.lossRed.total, 0.12);
});

test('flattenStats / changedKeys：属性卡、换将、换兵种都能检测到，首次不算变化', () => {
  const t = team();
  const f0 = flattenStats(buildStatsView(t, balance, cfg));
  assert.equal(changedKeys(null, f0).size, 0);
  assert.equal(changedKeys(f0, flattenStats(buildStatsView(t, balance, cfg))).size, 0);
  // 兵数变化（征兵 / 交战）只改战力总值与速度，不算“属性变化”，不高亮
  assert.equal(changedKeys(f0, flattenStats(buildStatsView({ ...t, soldiers: 77 }, balance, cfg))).size, 0);
  t.generals[0].int += 5; // 属性卡：主角智力 +5
  const f1 = flattenStats(buildStatsView(t, balance, cfg));
  assert.deepEqual([...changedKeys(f0, f1)].sort(), ['gen.hero.int', 'hero.int', 'intRed', 'lossRed']);
  t.generals.push(lib('zhangfei')); // 得到武将 → 主将、上限、战力等变化
  const f2 = flattenStats(buildStatsView(t, balance, cfg));
  const c2 = changedKeys(f1, f2);
  for (const k of ['gen.zhangfei.lead', 'L', 'cap', 'powerMult']) assert.ok(c2.has(k), k);
  t.unit = 'cav'; // 兵种令 → 兵种、擅长兵种、速度
  const c3 = changedKeys(f2, flattenStats(buildStatsView(t, balance, cfg)));
  for (const k of ['unit', 'affinity', 'powerMult']) assert.ok(c3.has(k), k);
});

test('fmtPct', () => {
  assert.equal(fmtPct(0.12), '12%'); assert.equal(fmtPct(0.668), '66.8%'); assert.equal(fmtPct(0.1234), '12.3%'); assert.equal(fmtPct(null), '-');
});

test('v0.6：统帅永远是主角，战力统率项 = k_lead × L（L = 主角统率 + 0.3×Σ副将统率），速度用 min(L,100)', () => {
  const v0 = buildStatsView(team(), balance, cfg);
  assert.equal(v0.leader.id, 'hero'); assert.equal(v0.L.total, 40); assert.equal(v0.L.deputies, 0);
  const t = team({ generals: [hero(), lib('zhangfei'), lib('zhugeliang')] });
  const v = buildStatsView(t, balance, cfg);
  assert.equal(v.leader.id, 'hero');
  assert.deepEqual(v.generals.map(g => g.role), ['leader', 'deputy', 'deputy']);
  near(v.L.total, 40 + 0.3 * (85 + 92)); assert.equal(v.L.speedCap, 100);
  assert.equal(v.maxGenerals, balance.team_rules.max_generals);
  near(v.power.lead, balance.power.k_lead * (40 + 0.3 * 177));
  near(v.power.total, computePower(t, balance));
});

test('面板文字：小面板 = 统帅（主角）+ 四维；详情 = 统帅 / 副将 + 派生值，keys 对得上 flattenStats', async () => {
  const { compactLines, detailLines, statsLayout } = await import('../src/ui/statsText.js');
  const t = team({ generals: [hero(), lib('zhangfei')] });
  const v = buildStatsView(t, balance, cfg), flat = flattenStats(v);
  const c = compactLines(v);
  assert.match(c[0].text, /^★ 统帅\s+主角/); assert.match(c[1].text, /统率 40.*武力 45/); assert.match(c[2].text, /智力 40.*魅力 50/);
  assert.match(c[3].text, /统率项 L 65\.5（含副将×0\.3）/); // 40 + 0.3×85
  assert.equal(compactLines(buildStatsView(team(), balance, cfg)).length, 3);
  const d = detailLines(v), all = d.map(l => l.text).join('\n');
  for (const s of ['★ 统帅 主角', '副将 张飞', '※ 统率项 L = 主角统率 40 + 0.3×副将统率 85 = 65.5（速度按 min(L, 100)）', `兵力上限 ${v.cap.total}`, '智力减伤 12%', `魅力收编率 ${fmtPct(v.recruit.total)}`, '总损兵减免', '武将 2/3']) assert.ok(all.includes(s), s);
  assert.ok(!all.includes('主将'), '不再显示“主将”字段');
  assert.ok(!all.includes('统率最高'), '不再有“按统率最高者结算”的说明');
  for (const l of [...c, ...d]) for (const k of l.keys) assert.ok(k in flat, k);
  const land = statsLayout({ width: 1280, height: 720 }), port = statsLayout({ width: 390, height: 844 });
  assert.equal(land.portrait, false); assert.equal(port.portrait, true);
  assert.ok(port.compact.font < land.compact.font);
  assert.ok(port.detail.w <= 390 - 20 && land.detail.x + land.detail.w <= 1280);
});
