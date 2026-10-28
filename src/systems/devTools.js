/**
 * 开发用调试工具（F2 调试菜单调用；只被 ui/DebugMenu.js 引用，DebugMenu 只在 import.meta.env.DEV 下动态加载 → 正式构建里没有这段代码）。
 * 纯函数部分（pickDevHomeCity）可单测；applyXxx 操作 WorldScene。
 */
import { PLAYER, defMax } from './city.js';
import { addGeneralOrQueue } from './roster.js';

const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/**
 * 选一座城给玩家：
 *  - 还没有主城 → 最近的无主城（含有黄巾守军的洛阳；守军会被撤掉）→ mode 'home'
 *  - 已有主城 → 最近的另一座无主城 → mode 'relocate'（走正常的迁都弹窗 Y / N）；
 *    没有无主城 → 最近的势力大本营（调试时临时设为无主）→ mode 'relocate', freed: true
 * 纯函数：只读 cities / homeId / player 坐标，返回 { mode, cityId, freed } 或 null。
 */
export function pickDevHomeCity(cities, homeId, player) {
  const all = Object.values(cities ?? {}).filter(c => c.id !== homeId && c.owner !== PLAYER);
  const free = all.filter(c => c.owner == null).sort((a, b) => d2(a, player) - d2(b, player) || (a.id < b.id ? -1 : 1));
  if (!homeId) return free[0] ? { mode: 'home', cityId: free[0].id, freed: false } : null;
  if (free[0]) return { mode: 'relocate', cityId: free[0].id, freed: false };
  const owned = all.filter(c => c.owner != null).sort((a, b) => d2(a, player) - d2(b, player) || (a.id < b.id ? -1 : 1));
  return owned[0] ? { mode: 'relocate', cityId: owned[0].id, freed: true } : null;
}

/** 立即给主城 / 触发迁都弹窗。返回给玩家看的提示文字 */
export function applyDevHomeCity(world) {
  const st = world.state, pick = pickDevHomeCity(st.cities, st.homeCity, world.player);
  if (!pick) return '【调试】没有可用的城';
  const c = st.cities[pick.cityId];
  if (c.garrison) {
    for (const p of world.aiParties.filter(x => x.team.cityHold === c.id)) world.removeParty(p);
    c.garrison = null;
  }
  if (pick.freed) { c.devFreedOwner = c.owner; c.owner = null; } // QA-18：选 N 时 answerRelocate 把原主人还回去（名将军留在城里）
  if (pick.mode === 'home') { world.captureCity(c.id); return `【调试】立 ${c.name} 为主城（再按 F2 → 2 触发迁都）`; }
  world.onCaptureReady(c); // 已有主城 → city-prompt（Y 迁都 / N 不迁）
  return `【调试】迁都到 ${c.name}？按 Y / N${pick.freed ? '（大本营临时设为无主）' : ''}`;
}

/**
 * 填满地图队伍上限（balance.spawn.max_ai_teams），再跑一次刷新检查 → 触发 tuning_r1 T2「撤下过弱黄巾队」。
 * 返回 { added, total, max, removed }。
 */
export function applyDevFillTeams(world, max) {
  let added = 0;
  for (let i = 0; i < max * 4 && world.aiParties.length < max; i++) if (world.respawn()) added++;
  const before = world.staleRemoved ?? 0, oldLog = world.staleLog = [];
  const re = world.aiParties.length >= max ? world.respawn() : null; // 满员时的刷新：T2 检查（有符合条件的就撤 1 支再补 1 支）
  world.staleLog = null;
  const removed = (world.staleRemoved ?? 0) - before;
  return { added, total: world.aiParties.length, max, removed, removedNames: oldLog.slice(), replaced: removed > 0 && !!re };
}

/**
 * F2→4 给一名武将（PM 2026-10-23：测换将 / 流放 / 存城）：从自由池里取第一名（先 A 级、再 S 级、再其他）不在队里的名将，
 * 走和抽卡武将卡同一个入口 addGeneralOrQueue —— 有空位直接入队，满编进 pendingGenerals（名册弹窗：替换 / 送回主城 / 流放）。
 * 纯逻辑（只改 state / team），返回 { general, joined } 或 null（自由池里没有可给的）。
 */
export function devGiveGeneral(state, team, balance, atS = null) {
  const byId = Object.fromEntries(balance.generals.map(g => [g.id, g])), rank = { A: 0, S: 1 };
  const cands = state.freePool.filter(id => byId[id] && !team.generals.some(g => g.id === id) && id !== balance.hero?.id)
    .sort((a, b) => (rank[byId[a].tier] ?? 2) - (rank[byId[b].tier] ?? 2));
  if (!cands.length) return null;
  const b = byId[cands[0]], gen = { id: b.id, name: b.name, tier: b.tier, lead: b.lead, str: b.str, int: b.int, cha: b.cha };
  state.freePool = state.freePool.filter(x => x !== gen.id);
  const r = addGeneralOrQueue(state, team, gen, { source: 'dev', from: '调试', atS }, balance);
  return { general: gen, joined: r.joined };
}
export function giveGeneralText(r) {
  if (!r) return '【调试】自由池里没有可给的武将';
  return r.joined ? `【调试】${r.general.name}（${r.general.tier}）作为副将加入` : `【调试】${r.general.name}（${r.general.tier}）待安排：队伍已满（名册弹窗）`;
}

/**
 * F2→6 最近一座非我方城的城防直接归零（PM 2026-10-23：测 QA-01 城破后回复暂停）——不和守军交战、不动守军。
 * 和攻破时一样记 zeroAtS / zeroAwayS = 0 / lastHitS（city.js cityTick 的 breached 分支），之后按 regen_rule 计时。
 * 纯函数选城：最近的、城防 > 0 的非我方城；都已破则取最近的非我方城。返回城 id 或 null。
 */
export function pickDevWallCity(cities, player) {
  const all = Object.values(cities ?? {}).filter(c => c.owner !== PLAYER).sort((a, b) => d2(a, player) - d2(b, player) || (a.id < b.id ? -1 : 1));
  return (all.find(c => c.def > 0) ?? all[0])?.id ?? null;
}
export function devBreakWall(cities, player, tS) {
  const id = pickDevWallCity(cities, player);
  if (!id) return null;
  const c = cities[id];
  c.def = 0; c.zeroAtS = tS; c.zeroAwayS = 0; c.lastHitS = tS;
  return c;
}
export function breakWallText(c, balance) {
  if (!c) return '【调试】没有可用的城';
  const C = balance.v06.city;
  return `【调试】${c.name} 城防 → 0/${defMax(balance, c.defCh ?? 0)}（未和守军交战${c.garrison ? '，守军还在' : ''}；离开累计 ${C.break_window_s} s 后开始回复）`;
}

/** F2→3 的提示文字（QA-19：写明撤下了谁、补刷了没有；没撤时说明条件） */
export function fillTeamsText(r) {
  const head = `【调试】队伍 ${r.total}/${r.max}（补满新刷 ${r.added}）`;
  if (r.removed) return `${head}；T2 撤下过弱黄巾 ${r.removed} 支：${r.removedNames.join('、')}${r.replaced ? '，已补刷 1 支' : ''}`;
  return `${head}；T2 未触发：没有符合条件的黄巾队（战力低于玩家×比例、离玩家够远、不在交战）`;
}
