/**
 * 队伍武将名册变更（纯逻辑，无 Phaser；单测见 tests/roster.test.js）。
 * 规则：balance.rewards.capture_rules.player_full_team + roster.actions（v0.4）+ 已决定：
 *   - 队伍 < max_generals：新武将直接入队
 *   - 满编：进入 state.pendingGenerals 队列（先进先出），弹窗当场选择：
 *       replace(i)：替换随从 i（主角不可替换），被替换者 名将→自由池、黄巾头目→消失
 *       release   ：释放新武将，名将→自由池、头目→消失，获得 release_captive_points（v0.4：俘获和抽卡来源都给）
 * v0.6（roster_v06，balance.v06 存在时）：替换（换下的人去主城 / 流放）/ 送回主城 / 流放（+exile_points）；主城存放见 swapWithStore
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
  state.pendingGenerals.push({ general, source: meta.source, from: meta.from, createdAtGameS: meta.atS ?? null });
  return { joined: false };
}

/** 可被替换的随从下标（主角不在列表里） */
export function replaceableIndices(team, balance) {
  return team.generals.map((g, i) => i).filter(i => !isHero(team.generals[i], balance));
}

// ---------------- v0.6 名册（roster_v06）：主角 + 2 副将；主城存放 storage_max 名；替换 / 送回主城 / 流放 ----------------
const R06 = balance => balance.v06?.roster;
/** 主城存放上限（没有 v0.6 配置 = 0，即没有存放功能） */
export const storeCap = balance => R06(balance)?.storage_max ?? 0;
/** 有主城且主城有空位（送回主城 / 换下的人去主城的前提；人不在主城也可以） */
export function canStore(state, balance) {
  return !!state.homeCity && (state.cityStore?.length ?? 0) < storeCap(balance);
}
/** 流放点数：v0.6 roster.exile_points；没有 v0.6 = v0.5 release_captive_points */
export const exilePoints = balance => R06(balance)?.exile_points ?? balance.rewards.release_captive_points;

/** 流放：名将回自由池（头目消失）+ 点数 */
export function exileGeneral(state, g, balance) {
  returnToPool(state, g);
  const pts = exilePoints(balance);
  state.points += pts;
  return pts;
}
/** 送进主城存放 */
export function storeGeneral(state, g, balance) {
  if (!canStore(state, balance)) throw new Error('没有主城或主城已满');
  (state.cityStore ??= []).push(g);
}

/**
 * 换下 / 新武将三选一之后的战力预览（UI：每个按钮旁的「战力 旧 → 新」）。computePower 由调用方传入（避免循环依赖）。
 *   asDeputy：新武将作为副将加入（队伍未满时）；replace[i]：换下第 i 名副将、新武将顶上
 */
export function pendingPreview(team, general, balance, computePower) {
  const now = computePower(team, balance);
  const replace = replaceableIndices(team, balance).map(i => ({
    index: i, name: team.generals[i].name,
    before: now, after: computePower({ ...team, generals: team.generals.map((x, j) => (j === i ? general : x)) }, balance)
  }));
  const asDeputy = team.generals.length < balance.team_rules.max_generals
    ? { before: now, after: computePower({ ...team, generals: [...team.generals, general] }, balance) } : null;
  return { now, replace, asDeputy };
}

/**
 * 主城存放 ↔ 队伍（在主城 swap_radius_px 内、不在战斗中，条件由调用方判断）：
 *   teamIdx + storeIdx：副将与存放的武将对调；只有 storeIdx：取出入队（队伍要有空位）；只有 teamIdx：副将存进主城（要有空位）
 */
export function swapWithStore(state, team, teamIdx, storeIdx, balance) {
  const store = (state.cityStore ??= []);
  const hasT = Number.isInteger(teamIdx), hasS = Number.isInteger(storeIdx);
  if (hasT && !replaceableIndices(team, balance).includes(teamIdx)) throw new Error('主角不能存进主城');
  if (hasS && !store[storeIdx]) throw new Error('主城里没有这名武将');
  if (hasT && hasS) {
    const a = team.generals[teamIdx], b = store[storeIdx];
    team.generals[teamIdx] = b; store[storeIdx] = a;
    return { text: `${b.name} 出城入队，${a.name} 留守主城` };
  }
  if (hasS) {
    if (team.generals.length >= balance.team_rules.max_generals) throw new Error('队伍已满');
    const [b] = store.splice(storeIdx, 1); team.generals.push(b);
    return { text: `${b.name} 出城入队` };
  }
  if (hasT) {
    if (store.length >= storeCap(balance)) throw new Error('主城已满');
    const [a] = team.generals.splice(teamIdx, 1); store.push(a);
    return { text: `${a.name} 留守主城` };
  }
  throw new Error('没有选择武将');
}

/** 主城失守（city_v06.player_city.lost / C5）：存放的武将回自由池（头目消失） */
export function loseStore(state) {
  const lost = state.cityStore ?? [];
  for (const g of lost) returnToPool(state, g);
  state.cityStore = [];
  return lost;
}

/**
 * 处理队首待安排武将。
 * @param action v0.6：'replace'（换下副将 index，opts.dest = 'city' | 'exile'，缺省：主城有空位去主城，否则流放）
 *                     | 'to_city'（新武将送回主城存放）| 'exile' / 'release'（新武将流放：回自由池 + exile_points）
 * @param index  replace 时被换下副将在 team.generals 中的下标
 */
export function resolvePending(state, team, action, index, balance, opts = {}) {
  const entry = state.pendingGenerals[0];
  if (!entry) throw new Error('没有待安排的武将');
  const g = entry.general;
  if (action === 'release' || action === 'exile') {
    state.pendingGenerals.shift();
    const pts = exileGeneral(state, g, balance);
    return { action: 'exile', general: g, points: pts, text: `${balance.v06 ? '流放' : '释放'} ${g.name}，获得 ${pts} 点` };
  }
  if (action === 'to_city') {
    if (!canStore(state, balance)) throw new Error('没有主城或主城已满');
    state.pendingGenerals.shift();
    storeGeneral(state, g, balance);
    return { action, general: g, text: `${g.name} 送回主城存放` };
  }
  if (action === 'replace') {
    if (!replaceableIndices(team, balance).includes(index)) throw new Error('该武将不可替换');
    const dest = !balance.v06 ? 'pool' : opts.dest ?? (canStore(state, balance) ? 'city' : 'exile');
    if (dest === 'city' && !canStore(state, balance)) throw new Error('没有主城或主城已满');
    state.pendingGenerals.shift();
    const old = team.generals[index];
    team.generals[index] = g;
    if (dest === 'city') { storeGeneral(state, old, balance); return { action, general: g, replaced: old, dest, text: `${g.name} 替换 ${old.name}（${old.name} 回主城存放）` }; }
    if (dest === 'exile') {
      // 【假设 v06.exile_replaced_points】换下的人流放也 + exile_points（流放 = 回自由池 + 20 点）
      const pts = balance.v06?.prog?.exile_replaced_points === false ? (returnToPool(state, old), 0) : exileGeneral(state, old, balance);
      return { action, general: g, replaced: old, dest, points: pts, text: `${g.name} 替换 ${old.name}（${old.name} 流放${pts ? `，+${pts} 点` : ''}）` };
    }
    returnToPool(state, old);
    return { action, general: g, replaced: old, dest, text: `${g.name} 替换 ${old.name}${old.generic ? '（头目离去）' : '（回自由池）'}` };
  }
  throw new Error(`未知操作 ${action}`);
}

/**
 * 新武将弹窗的界面状态机（roster_v06.new_general_flow.ui_states，纯函数）：
 *   PENDING_GENERAL --replace--> CHOOSE_REPLACE --pick(i)--> CHOOSE_DEST --city/exile--> DONE（调用方 resolvePending + 自动存档）
 *   PENDING_GENERAL --to_city / exile--> DONE；CHOOSE_* --back--> 上一步
 * 返回新 flow；flow.resolve = [action, index, opts] 表示要提交的选择
 */
export function rosterFlowStep(flow, input, ctx) {
  const f = { ...flow, resolve: null };
  const { canCity, replaceable } = ctx;
  switch (flow.ui) {
    case 'PENDING_GENERAL':
      if (input.type === 'replace' && replaceable.length) return { ...f, ui: 'CHOOSE_REPLACE' };
      if (input.type === 'pick' && replaceable.includes(input.index)) return { ...f, ui: 'CHOOSE_DEST', replaceIdx: input.index }; // 直接点副将卡
      if (input.type === 'to_city' && canCity) return { ...f, ui: 'DONE', resolve: ['to_city', null] };
      if (input.type === 'exile') return { ...f, ui: 'DONE', resolve: ['exile', null] };
      return flow;
    case 'CHOOSE_REPLACE':
      if (input.type === 'pick' && replaceable.includes(input.index)) return { ...f, ui: 'CHOOSE_DEST', replaceIdx: input.index };
      if (input.type === 'back') return { ...f, ui: 'PENDING_GENERAL' };
      return flow;
    case 'CHOOSE_DEST':
      if (input.type === 'to_city' && canCity) return { ...f, ui: 'DONE', resolve: ['replace', flow.replaceIdx, { dest: 'city' }] };
      if (input.type === 'exile') return { ...f, ui: 'DONE', resolve: ['replace', flow.replaceIdx, { dest: 'exile' }] };
      if (input.type === 'back') return { ...f, ui: 'CHOOSE_REPLACE', replaceIdx: null };
      return flow;
    default: return flow;
  }
}
export const newRosterFlow = () => ({ ui: 'PENDING_GENERAL', replaceIdx: null, resolve: null });
