/**
 * 数据入口：统一加载策划配置。
 * balance.json 是 /workspace/design/balance_v0.2.json 的副本（npm run sync:balance 同步）。
 * 初始队伍 = balance.initial_teams；阵营颜色 = balance.ai.factions[].color / player_faction.color。
 */
import balance from './balance.json';
import display from './display.json';
import assumptions from './assumptions.json';
import { buildTeam, indexBalance, createNameAllocator } from '../systems/teams.js';
import { mulberry32 } from '../systems/rng.js';
import { TEAM_SEED } from '../config.js';

export { balance, display, assumptions };
export const index = indexBalance(balance);

const rng = mulberry32(TEAM_SEED);
/** 全局黄巾头目名字分配器（初始队伍与补充刷新共用，保证不重名） */
export const nextBanditName = createNameAllocator(balance, rng);

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
