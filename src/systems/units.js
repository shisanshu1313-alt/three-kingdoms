import { mulberry32 } from './rng.js'; // 默认随机数也是种子流（游戏里都显式传入；不用 Math.random，保证可复现）
/**
 * v0.5 兵种（balance_v0.5.json → units）：一支队伍一个兵种（team.unit = inf | cav | arc | spr）。
 *   主角开局步兵（局外解锁可选别的）；名将军按 named_army_units；
 *   黄巾按章节比例（chapters.list[].bandit_units）：inf = 步兵比例，uniform = 四种均匀，target = 克制玩家 60 s 前兵种的兵种
 */
export const UNIT_TYPES = ['inf', 'cav', 'arc', 'spr'];
export const UNIT_NAMES = { inf: '步', cav: '骑', arc: '弓', spr: '枪' };
export const UNIT_FULL_NAMES = { inf: '步兵', cav: '骑兵', arc: '弓兵', spr: '枪兵' };

/** 黄巾兵种：mix = { inf, uniform, target }，targetUnit = 克制玩家（60 s 前兵种）的兵种 */
export function pickBanditUnit(mix, rng, targetUnit = null) {
  const r = rng();
  if (targetUnit && r < (mix.target ?? 0)) return targetUnit;
  const r2 = r - (targetUnit ? (mix.target ?? 0) : 0);
  if (r2 < (mix.inf ?? 0)) return 'inf';
  return UNIT_TYPES[Math.floor(rng() * UNIT_TYPES.length) % UNIT_TYPES.length];
}

/** 队伍没有兵种时补上（新局、刷新、旧存档）；opts.mix / opts.targetUnit 给刷新的黄巾用 */
export function assignUnit(team, combatJson, rng = mulberry32(0x5eed), opts = {}) {
  if (team.unit && UNIT_TYPES.includes(team.unit)) return team;
  if (team.is_player) { team.unit = opts.playerUnit ?? combatJson.confirmed.player_start_unit; return team; }
  const named = combatJson.named_army_units?.[team.id];
  if (named) { team.unit = named; return team; }
  const ch1 = combatJson.confirmed.bandit_units_ch1;
  team.unit = pickBanditUnit(opts.mix ?? { inf: ch1.inf, uniform: ch1.uniform_rest, target: 0 }, rng, opts.targetUnit ?? null);
  return team;
}
