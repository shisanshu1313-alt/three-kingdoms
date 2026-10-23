/**
 * 开发用调试工具（F2 调试菜单调用；只被 ui/DebugMenu.js 引用，DebugMenu 只在 import.meta.env.DEV 下动态加载 → 正式构建里没有这段代码）。
 * 纯函数部分（pickDevHomeCity）可单测；applyXxx 操作 WorldScene。
 */
import { PLAYER } from './city.js';

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

/** F2→3 的提示文字（QA-19：写明撤下了谁、补刷了没有；没撤时说明条件） */
export function fillTeamsText(r) {
  const head = `【调试】队伍 ${r.total}/${r.max}（补满新刷 ${r.added}）`;
  if (r.removed) return `${head}；T2 撤下过弱黄巾 ${r.removed} 支：${r.removedNames.join('、')}${r.replaced ? '，已补刷 1 支' : ''}`;
  return `${head}；T2 未触发：没有符合条件的黄巾队（战力低于玩家×比例、离玩家够远、不在交战）`;
}
