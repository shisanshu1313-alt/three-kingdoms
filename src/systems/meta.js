/**
 * v0.5 局外数据（meta_progression B：解锁型，只横向、不加数值）。纯函数 + 存储接口（platform/storage.js），键 save_v05.keys.meta。
 *   meta = { version, fameTotal, runs, clears, bestSurvivedS, bestPower, namedEver[], maxChapterEver, unlocked[], recordedRunIds[], has_started_run }
 *   has_started_run（策划 2026-10-23）：点过「开始」进过一局就是 true（哪怕没解锁、中途放弃）→ 标题页不再是「第一次打开」版。
 *   名望只用于判定累计门槛，不消耗；同一 runId 只记一次（save_v05.death：带 runId 防重复累计）。
 */
export const META_VERSION = 1;

export function createMeta() {
  return { version: META_VERSION, fameTotal: 0, runs: 0, clears: 0, bestSurvivedS: 0, bestPower: 0,
    namedEver: [], maxChapterEver: 0, unlocked: [], recordedRunIds: [], has_started_run: false };
}

/**
 * 是否已经开过局（纯函数）。旧档迁移：meta 里没有 has_started_run 字段时，meta.runs > 0 / 有解锁 / 存储里已有任何存档
 * （进行中的一局，含损坏 / 不兼容的；或已归档的旧版存档）都算 true。
 */
export function hasStartedRun(meta, { runSave = false, legacy = false } = {}) {
  return !!(meta?.has_started_run || meta?.runs > 0 || meta?.unlocked?.length || runSave || legacy);
}
/** 标记已开过局（不改入参） */
/** 存储里的 meta 文本是否已经写了 has_started_run = true（旧档迁移后写回一次用） */
export function storedStartedFlag(text) {
  try { return JSON.parse(text)?.has_started_run === true; } catch { return false; }
}
export const markStartedRun = (meta) => ({ ...(meta ?? createMeta()), has_started_run: true });

function condMet(c, m) {
  if (c.chapter_reached != null && m.maxChapterEver < c.chapter_reached) return false;
  if (c.defeated && !m.namedEver.includes(c.defeated)) return false;
  if (c.fame_total != null && m.fameTotal < c.fame_total) return false;
  if (c.cleared && m.clears < 1) return false;
  return true;
}

/** 一局结束 → 新 meta（不改入参）+ 本次新解锁 */
export function applyRunResult(meta, summary, cfg) {
  const m = structuredClone(meta ?? createMeta());
  if (m.recordedRunIds.includes(summary.runId)) return { meta: m, newUnlocks: [], duplicate: true };
  m.recordedRunIds = [...m.recordedRunIds, summary.runId].slice(-50);
  m.runs++;
  m.fameTotal += summary.fame;
  if (summary.result === 'victory') m.clears++;
  m.bestSurvivedS = Math.max(m.bestSurvivedS, summary.survivedS);
  m.bestPower = Math.max(m.bestPower, summary.maxPower);
  m.maxChapterEver = Math.max(m.maxChapterEver, summary.chapterReached);
  m.namedEver = [...new Set([...m.namedEver, ...summary.namedDefeated])];
  const newUnlocks = [];
  for (const u of cfg.meta.unlocks) if (!m.unlocked.includes(u.id) && condMet(u.cond, m)) { m.unlocked.push(u.id); newUnlocks.push(u); }
  return { meta: m, newUnlocks, duplicate: false };
}

/** 新局可选项：开局兵种 / 随从 / 物品 / 群雄模式 */
export function startOptions(meta, cfg, baseItem = 'war_drum') {
  const un = new Set(meta?.unlocked ?? []);
  const U = cfg.meta.unlocks;
  const units = ['inf', ...U.filter(u => u.kind === 'start_unit' && un.has(u.id)).map(u => u.unit)];
  const generals = U.filter(u => u.kind === 'start_general' && un.has(u.id)).map(u => u.general);
  const itemU = U.find(u => u.kind === 'start_item' && un.has(u.id));
  const items = [baseItem, ...(itemU ? itemU.items : [])];
  return { units, generals, items, hard: un.has('hard_mode') };
}

export function parseMeta(text) {
  if (!text) return createMeta();
  try {
    const m = JSON.parse(text);
    if (!m || typeof m !== 'object' || m.version !== META_VERSION) return createMeta();
    const out = { ...createMeta(), ...m };
    if (typeof m.has_started_run !== 'boolean') out.has_started_run = hasStartedRun(m); // 旧档：没有这个字段 → 按 runs / 解锁推断
    return out;
  } catch { return createMeta(); }
}
export const loadMeta = (storage, key) => parseMeta(storage.get(key));
export function saveMeta(storage, key, meta) {
  try { storage.set(key, JSON.stringify(meta)); return true; } catch (e) { console.warn('[meta] 写入失败', e); return false; }
}
