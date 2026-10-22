/**
 * 数据入口：统一加载策划配置。
 * balance.json 是 /workspace/design/balance_v0.4.json 的副本（npm run sync:balance 同步）。
 * 初始队伍 = balance.initial_teams；阵营颜色 = balance.ai.factions[].color / player_faction.color。
 */
import balance from './balance.json' with { type: 'json' };
import display from './display.json' with { type: 'json' };
import assumptions from './assumptions.json' with { type: 'json' };
import { buildTeam, indexBalance, createNameAllocator } from '../systems/teams.js';
import { mulberry32 } from '../systems/rng.js';
import { TEAM_SEED } from '../config.js';

export { balance, display, assumptions };
export const index = indexBalance(balance);

/** 队伍/名字用的种子随机数（存档会保存其状态） */
export const teamRng = mulberry32(TEAM_SEED);
const rng = teamRng;
/** 全局黄巾头目名字分配器（初始队伍与补充刷新共用，保证不重名；存档保存已用名） */
export const nextBanditName = createNameAllocator(balance, rng);

/** 新游戏：随机数与名字池回到初始状态（同一页面里“新游戏 / 读档”时调用） */
export function resetWorldRandom() {
  teamRng.setState(TEAM_SEED);
  nextBanditName.reset();
}

export function factionColor(faction) {
  if (faction === balance.player_faction?.id) return balance.player_faction.color;
  return index.factionsById[faction]?.color || display.defaultColor;
}

/** 构建 initial_teams 中的全部队伍，配置问题打印 warning */
export function loadInitialTeams() {
  const teams = balance.initial_teams.map(def => {
    const { team, warnings } = buildTeam(def, balance, rng, index, nextBanditName);
    warnings.forEach(w => console.warn('[data]', w));
    return team;
  });
  return { player: teams.find(t => t.is_player), ai: teams.filter(t => !t.is_player) };
}
