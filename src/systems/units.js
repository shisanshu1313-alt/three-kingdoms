/**
 * v0.5 兵种（balance_v0.5.json → units）：一支队伍一个兵种（team.unit = inf | cav | arc | spr）。
 *   主角开局步兵；名将军按 named_army_units；黄巾按章节兵种比例（第 1 章：70% 步兵，30% 四种均匀）
 */
export const UNIT_TYPES = ['inf', 'cav', 'arc', 'spr'];
export const UNIT_NAMES = { inf: '步', cav: '骑', arc: '弓', spr: '枪' };

/** 队伍没有兵种时补上（新局、刷新、旧存档）；rng 只用于黄巾 */
export function assignUnit(team, combatJson, rng = Math.random) {
  if (team.unit && UNIT_TYPES.includes(team.unit)) return team;
  if (team.is_player) { team.unit = combatJson.confirmed.player_start_unit; return team; }
  const named = combatJson.named_army_units?.[team.id];
  if (named) { team.unit = named; return team; }
  const mix = combatJson.confirmed.bandit_units_ch1;
  team.unit = rng() < mix.inf ? 'inf' : UNIT_TYPES[Math.floor(rng() * UNIT_TYPES.length) % UNIT_TYPES.length];
  return team;
}
