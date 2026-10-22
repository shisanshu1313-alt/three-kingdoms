// 从策划正式配置 balance_v0.5.json 生成 src/data/combat_v05.json（战斗原型用）。用法：node scripts/sync-v05.mjs [草案路径]
// 只拷贝数值字段（move_params / 3_cooldown / named_army_units / 兵种克制）；文字里的数和程序自己定的值放在 assumed（【假设】）。
import { readFileSync, writeFileSync } from 'node:fs';
const src = process.argv[2] || new URL('../../design/balance_v0.5.json', import.meta.url);
const d = JSON.parse(readFileSync(src, 'utf8'));
const bm = d.battle_move, cd = bm.mvp_fields['3_cooldown'];
const out = {
  _source: { file: 'balance_v0.5.json', version: d._meta.version, note: '由 scripts/sync-v05.mjs（npm run sync:v05）生成，勿手改' },
  tick_s: bm.tick_s,
  move: d.move_params,
  cooldown: { protect_s: cd.protect_s, ignore_s: cd.ignore_s, pair_cd_s: cd.pair_cd_s, charge_cd_s: cd.charge_cd_s, no_hp_regen_s: cd.no_hp_regen_s },
  named_army_units: d.units.named_army_units,
  chapter: 0,
  assumed: {
    _comment: '【假设】v0.5 里只有文字或没写的值，程序先定。说明见 assumptions.json 的 combat_v05 段',
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
    player_wipe_keep_soldiers: 5,
    draw_ignore_s: 10,
    arrive_px: 6,
    player_rout_once_per_battle: true,
    max_overlap_px: 4
  }
};
writeFileSync(new URL('../src/data/combat_v05.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log('combat_v05.json <-', d._meta.version);
