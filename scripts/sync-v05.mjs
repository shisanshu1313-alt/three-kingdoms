// 从策划正式配置 /workspace/design/balance_v0.5.json 生成：
//   src/data/combat_v05.json —— 实时战斗（move_params / 3_cooldown / 兵种）+ confirmed（策划已确认的程序取值，见 confirmed_assumptions）
//   src/data/run_v05.json    —— 一局的规则（章节 / 快节奏 / 失败 B / 局外解锁 B / 存档 / 兵种扩展）
// 用法：npm run sync:v05 [配置路径]。正式配置里只有文字的规则，在这里转成结构化数值（注释标【解读】）。
import { readFileSync, writeFileSync } from 'node:fs';
const src = process.argv[2] || new URL('../../design/balance_v0.5.json', import.meta.url);
const d = JSON.parse(readFileSync(src, 'utf8'));
const bm = d.battle_move, cd = bm.mvp_fields['3_cooldown'];
const ca = d.confirmed_assumptions;
if (!ca || !/确认/.test(ca.status ?? '')) throw new Error('balance_v0.5.json 缺 confirmed_assumptions（策划确认）');
const source = { file: 'balance_v0.5.json', version: d._meta.version, note: '由 scripts/sync-v05.mjs（npm run sync:v05）生成，勿手改' };

const combat = {
  _source: source,
  tick_s: bm.tick_s,
  move: d.move_params,
  cooldown: { protect_s: cd.protect_s, ignore_s: cd.ignore_s, pair_cd_s: cd.pair_cd_s, charge_cd_s: cd.charge_cd_s, no_hp_regen_s: cd.no_hp_regen_s },
  named_army_units: d.units.named_army_units,
  chapter: 0,
  // 策划已确认（confirmed_assumptions，2026-10-22）：原型的取值全部按原样写入正式版
  confirmed: {
    _comment: `策划确认 ${ca.date}：${ca.status}`,
    retreat_by_personality: { aggressive: [0.5, 0.25], normal: [0.7, 0.15], cautious: [0.9, 0.10] },
    others_give_up_player_s: 8,
    hitrun_hold_s: 1.0,
    walk_vs_brace_mult: 0.4,
    kite_gap_px: [72, 114],
    bandit_units_ch1: { inf: 0.7, uniform_rest: 0.3 },
    player_start_unit: 'inf',
    rear_min_speed_frac: 0.2,
    arrow_moving_frac: 0.3,
    turn_low_speed_frac: 0.3,
    escaping_heading_deg: 90,
    escaping_min_speed_frac: 0.2,
    attack_cancels_protection_closing: 0.5,
    draw_ignore_s: 10,
    arrive_px: 6,
    player_rout_once_per_battle: true, // answers.player_rout_once_per_battle
    both_retreating_both_protected: true, // answers.both_retreating
    max_overlap_px: 4
  },
  answers: ca.answers
};

// ---------- 抽卡（gacha_v05：唯一来源；cost 是公式文字 "min(30 + 3n, 90)"，weights / pool_notes 生成卡池） ----------
function parseNum(text, re) { const m = re.exec(text ?? ''); if (!m) throw new Error(`balance_v0.5.json 解析失败：${re} 不匹配 "${text}"`); return Number(m[1]); }
const gv = d.gacha_v05;
const costM = /min\(\s*(\d+)\s*\+\s*(\d+)\s*n\s*,\s*(\d+)\s*\)/.exec(gv.cost ?? '');
if (!costM) throw new Error(`gacha_v05.cost 无法解析："${gv.cost}"（期望 min(a + bn, cap)）`);
const gachaCost = { base: +costM[1], step: +costM[2], cap: +costM[3] };
const notes = gv.pool_notes ?? {};
const gachaPool = Object.entries(gv.weights).map(([type, weight]) => {
  const e = { type, weight };
  if (type.startsWith('attr_')) e.attr_amount = parseNum(notes[type], /attr_amount\s*(\d+)/);
  else if (type === 'item') e.item_source = `items_all_uniform（${notes.item ?? ''}）`;
  else if (type.startsWith('general_')) e.tier = type.slice('general_'.length);
  else if (notes[type]) e.effect = notes[type];
  return e;
});
const pm = d.polish_merged;

// ---------- 一局的规则 ----------
const fp = d.fast_pace, rb = d.failure.rules_B, sf = rb.soldier_floor_redesign, gt = fp.growth_tuning;
const dur = fp.duration_options.find(o => o.min === fp.recommend);
const unitMix = { // 【解读】chapters.list[].bandit_units 文字 → 比例；target = 克制玩家 60 s 前兵种的兵种
  1: { inf: 0.7, uniform: 0.3, target: 0 },
  2: { inf: 0, uniform: 1, target: 0 },
  3: { inf: 0, uniform: 0.65, target: 0.35 },
  4: { inf: 0, uniform: 0.5, target: 0.5 }
};
const namedChase = { 1: null, 2: null, 3: 420, 4: 420 }; // 【解读】第 1–2 章坐镇不追；第 3 章起领地 home 420 px 内追（numeric_impact.chase）
const run = {
  _source: source,
  duration_min: dur.min,
  chapters: d.chapters.list.map((c, i) => ({
    id: c.id, name: c.name, start_s: dur.chapters_min[i] * 60, counter_mult: d.units.counter_mult_by_chapter[i],
    spawn_power_vs_player: c.spawn_power_vs_player, bandit_units: unitMix[c.id], named_chase_home_px: namedChase[c.id]
  })),
  target_lag_s: 60, // chapters.spawn_unit_targeting：针对玩家 60 s 前的兵种
  map: fp.map,
  density: fp.density,
  first_battle: { at_s: 20, power_vs_player: [0.6, 0.8], dist_px: [350, 450], ignores_grace: true }, // 【解读】fast_pace.first_battle.rule
  grace_s: 90, // fast_pace.grace.rule
  growth: { gacha_cost: gachaCost, points: { base: 8, per_power: 0.45 }, recruit_base: gt.recruit_base }, // gacha_cost ← gacha_v05.cost；points【解读】growth_tuning 公式
  failure: {
    hero_hp_max: rb.hero_hp_max, hero_hp_per_dead: rb.hero_hp_per_dead, hero_hp_rout: rb.hero_hp_rout, hero_hp_esc_fail: rb.hero_hp_esc_fail,
    regen_out_of_battle_per_min: rb.hp_regen.out_of_battle_per_min, regen_in_city_per_s: rb.hp_regen.in_city_per_s,
    no_regen_after_battle_s: cd.no_hp_regen_s ?? 5,
    recruit_floor: sf.recruit_floor, recruit_interval_s: sf.recruit_interval_s, city_radius_px: sf.city_radius_px
  },
  run_goal: { named: Object.keys(d.run_goal.named_power_v04) }, // 讨伐 4 路名将
  meta: {
    fame: { per_min: 2, per_named: 50, power_div: 10 }, // 【解读】fame 公式
    unlocks: [ // 【解读】meta_progression B 的 unlocks 文字 → 条件
      { id: 'start_spr', kind: 'start_unit', unit: 'spr', name: '开局兵种：枪兵', cond: { chapter_reached: 2 } },
      { id: 'start_arc', kind: 'start_unit', unit: 'arc', name: '开局兵种：弓兵', cond: { defeated: 'wu_zhouyu' } },
      { id: 'start_cav', kind: 'start_unit', unit: 'cav', name: '开局兵种：骑兵', cond: { defeated: 'qun_lvbu' } },
      { id: 'start_liaohua', kind: 'start_general', general: 'liaohua', name: '开局随从：廖化（B）', cond: { fame_total: 300 } },
      { id: 'start_item', kind: 'start_item', items: ['fine_horse', 'art_of_war', 'banner'], replaces: 'war_drum', name: '开局物品可选：良马 / 兵书 / 招降旗', cond: { fame_total: 600 } },
      { id: 'hard_mode', kind: 'mode', name: '群雄模式（难度 +1）', spawn_power_add: 0.1, counter_mult_add: 0.05, cond: { cleared: true } }
    ]
  },
  save: { keys: d.save_v05.keys && { run: d.save_v05.keys.run, meta: d.save_v05.keys.meta, legacy_from: 'sanguo-save', legacy_to: 'sanguo-save-legacy' },
    autosave_s: 30, battle_snapshot_s: 1, resume_countdown_s: 3, delete_on_victory: true }, // delete_on_victory：【解读】一局结束（胜或败）都不能继续
  units: {
    affinity: { m_bonus: 0.10, table: d.units.general_affinity.table },
    counter_items: d.units.counter_items,
    change_unit_city: { cost: 30, lock_s: 5, radius_px: 200 }, // 【解读】units.change_unit.city 文字
    unit_order_refund: 25,
    drill: { add: 0.05, max: 3 },
    scouting: { vision_px: d.units.scouting.vision_px, scout_px: d.units.scouting.scout_px }
  },
  gacha_pool: gachaPool,
  // polish_merged（随 v0.5 一起定）
  capture: { generic_capturable: false }, // 1_bandit_head_no_capture：factions.bandit.generic_capturable = false
  faction_refill: { // 3_faction_refill【解读】文字 → 数值
    enabled: true, lead_str: [60, 80], int_cha: [40, 70], power_floor: 120, power_rand: [0.8, 1.2],
    // 【假设，待策划确认】名将军被别的 AI 打掉（玩家没有份额，不算讨伐）后，该势力只剩校尉军；这时击败该势力的校尉军也算讨伐，
    // 否则这一局永远无法通关（模拟 sim_v05_world.py 里校尉军 main=True，击败即讨伐）
    counts_when_named_lost: true
  },
  named_reinforce: { per_min: parseNum(pm['4_named_reinforce'].rule, /每分钟\s*\+\s*(\d+)\s*兵/), ref_duration_min: 20 } // 4_named_reinforce：按 20/时长 缩放
};
writeFileSync(new URL('../src/data/combat_v05.json', import.meta.url), JSON.stringify(combat, null, 2) + '\n');
writeFileSync(new URL('../src/data/run_v05.json', import.meta.url), JSON.stringify(run, null, 2) + '\n');
console.log('combat_v05.json + run_v05.json <-', d._meta.version);
