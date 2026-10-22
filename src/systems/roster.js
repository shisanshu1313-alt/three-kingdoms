/**
 * 队伍武将名册变更（纯逻辑，无 Phaser；单测见 tests/roster.test.js）。
 * 规则：balance.rewards.capture_rules.player_full_team / gacha.team_full_general（v0.2）+ 已决定：
 *   - 队伍 < max_generals：新武将直接入队
 *   - 满编：进入 state.pendingGenerals 队列（先进先出），弹窗当场选择：
 *       replace(i)：替换随从 i（主角不可替换），被替换者 名将→自由池、黄巾头目→消失
 *       release   ：释放新武将，名将→自由池、头目→消失，获得 release_captive_points
 */

export const isHero = (g, balance) => g.id === balance.hero?.id;

/** 名将回自由池；黄巾头目（generic）消失（已决定：名将只回自由池） */
export function returnToPool(state, general) {
  if (!general.generic && !state.freePool.includes(general.id)) state.freePool.push(general.id);
}

/** 新武将：有空位直接入队，满编进队列。返回 {joined} */
export function addGeneralOrQueue(state, team, general, meta, balance) {
  if (team.generals.length < balance.team_rules.max_generals) {
    team.generals.push(general);
    return { joined: true };
  }
  state.pendingGenerals.push({ general, source: meta.source, from: meta.from });
  return { joined: false };
}

/** 可被替换的随从下标（主角不在列表里） */
export function replaceableIndices(team, balance) {
  return team.generals.map((g, i) => i).filter(i => !isHero(team.generals[i], balance));
}

/**
 * 处理队首待安排武将。
 * @param action 'replace' | 'release'
 * @param index  replace 时被替换随从在 team.generals 中的下标
 */
export function resolvePending(state, team, action, index, balance) {
  const entry = state.pendingGenerals[0];
  if (!entry) throw new Error('没有待安排的武将');
  const g = entry.general;
  if (action === 'release') {
    state.pendingGenerals.shift();
    returnToPool(state, g);
    const pts = balance.rewards.release_captive_points;
    state.points += pts;
    return { action, general: g, points: pts, text: `释放 ${g.name}，获得 ${pts} 点` };
  }
  if (action === 'replace') {
    if (!replaceableIndices(team, balance).includes(index)) throw new Error('该武将不可替换');
    state.pendingGenerals.shift();
    const old = team.generals[index];
    team.generals[index] = g;
    returnToPool(state, old);
    return { action, general: g, replaced: old, text: `${g.name} 替换 ${old.name}${old.generic ? '（头目离去）' : '（回自由池）'}` };
  }
  throw new Error(`未知操作 ${action}`);
}
