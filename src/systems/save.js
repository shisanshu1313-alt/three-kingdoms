/**
 * 存档（纯逻辑，无 Phaser / 浏览器依赖；单测见 tests/save.test.js）。
 * 读写通过存储接口 storage = { get, set, remove }（src/platform/storage.js），由调用方传入。
 *
 * 存档结构（saveVersion 2，v0.4 起所有计时都用游戏时钟 core/GameClock.js）：
 * {
 *   saveVersion, balanceVersion, mapSeed, savedAt(ISO 真实时间，仅显示用), reason,
 *   gameTimeMs,                       // 游戏时钟 now；下面所有时间都是这个时钟上的绝对时刻
 *   state:  { points, gachaDraws, freePool, pendingGenerals, captured, battleLog, battles },
 *   player: { team, mainGeneralId, invincibleUntil, graceUntil },
 *   ai:     [{ team, mem: { state, targetId, since(秒), ignore: {id: 截止秒}, idleUntil }, graceUntil }],
 *   spawn:  { counter },              // 补充刷新已刷支数（决定 id）
 *   timers: { respawn, autosave },    // 各定时器下一次触发的游戏时间
 *   names:  { pool, n },              // 黄巾头目名字池剩余 + 「黄巾头目N」序号
 *   rng:    { team },                 // 种子随机数状态（其余随机用 Math.random，不保存）
 *   pairCooldowns: [[pairKey, 截止ms]],
 *   camera: { zoom }
 * }
 * 读档时游戏时钟从 gameTimeMs 继续，所以截止时间原样还原。
 * team = balance.team_example 结构（+ name/home/state），武将含当前（已强化）属性。
 * v1（存剩余时长）→ v2 的转换见 MIGRATIONS[1]。
 */

export const SAVE_VERSION = 2;
export const SAVE_KEY = 'sanguo-save';

/**
 * 迁移钩子：MIGRATIONS[v] 把 saveVersion=v 的存档升级到 v+1（返回新对象）。
 * 例：2 版加字段 → MIGRATIONS[1] = s => ({ ...s, saveVersion: 2, newField: 默认值 })
 */
export const MIGRATIONS = {
  /** v1（真实时钟，存剩余时长）→ v2（游戏时钟，存绝对时刻）：截止时间 = gameTimeMs + 剩余 */
  1: (s) => {
    const T = s.gameTimeMs ?? 0, out = { ...s, saveVersion: 2 };
    if (s.player) {
      const { invincibleMs = 0, graceMs = 0, ...rest } = s.player;
      out.player = { ...rest, invincibleUntil: T + invincibleMs, graceUntil: T + graceMs };
    }
    out.ai = (s.ai || []).map(a => {
      const { graceMs = 0, mem, ...rest } = a || {};
      return { ...rest, mem: memV1toV2(mem, T), graceUntil: T + graceMs };
    });
    const { nextMs = 0, ...spawn } = s.spawn || {};
    out.spawn = spawn;
    out.timers = { respawn: T + nextMs };
    out.pairCooldowns = (s.pairCooldowns || []).map(([k, ms]) => [k, T + ms]);
    return out;
  }
};

function memV1toV2(m, T) {
  const nowS = T / 1000, ignore = {};
  for (const [id, left] of Object.entries(m?.ignore || {})) ignore[id] = nowS + left;
  return { state: m?.state ?? 'wander', targetId: m?.targetId ?? null, since: nowS - (m?.sinceAgoS ?? 0), ignore, idleUntil: T + (m?.idleMs ?? 0) };
}

export class SaveError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** snapshot（WorldScene.snapshot() 的纯数据）→ 带版本信息的存档对象 */
export function makeSave(snapshot, { balance, mapSeed, reason = 'auto', now = new Date() }) {
  return {
    saveVersion: SAVE_VERSION,
    balanceVersion: balance._meta?.version ?? null,
    mapSeed,
    savedAt: now.toISOString(),
    reason,
    ...JSON.parse(JSON.stringify(snapshot)) // 只保留可 JSON 化的数据（undefined/函数被去掉），保证往返一致
  };
}

export const serialize = (save) => JSON.stringify(save);

/** 依次执行迁移到当前版本；缺迁移函数 → incompatible */
export function migrate(save, migrations = MIGRATIONS, target = SAVE_VERSION) {
  let s = save;
  while (s.saveVersion < target) {
    const fn = migrations[s.saveVersion];
    if (!fn) throw new SaveError('incompatible', `存档版本 ${s.saveVersion} 无法升级到 ${target}`);
    const from = s.saveVersion;
    s = fn(structuredClone(s));
    if (!(s?.saveVersion > from)) throw new SaveError('incompatible', `迁移 ${from} 没有提升版本号`);
  }
  return s;
}

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isInt = v => Number.isInteger(v);
const isStr = v => typeof v === 'string';
const ATTRS = ['lead', 'str', 'int', 'cha'];

/** 结构 + 引用完整性校验；返回错误列表（空 = 通过） */
export function validateSave(s, balance) {
  const errs = [];
  const need = (cond, msg) => { if (!cond) errs.push(msg); };
  const known = new Set([...balance.generals.map(g => g.id), balance.hero?.id]);
  const items = new Set(balance.items.map(i => i.id));
  const rules = balance.team_rules;
  const W = balance.map.tiles_w * balance.map.tile_px, H = balance.map.tiles_h * balance.map.tile_px;

  const general = (g, where) => {
    if (!g || typeof g !== 'object') return errs.push(`${where}: 武将格式错误`);
    need(isStr(g.id) && isStr(g.name), `${where}: 武将缺 id/name`);
    for (const a of ATTRS) need(isNum(g[a]) && g[a] >= 0 && g[a] <= balance.gacha.attr_cap, `${where}.${g.id}.${a} 非法: ${g[a]}`);
    if (!g.generic) need(known.has(g.id), `${where}: 未知武将 ${g.id}`);
  };
  const team = (t, where) => {
    if (!t || typeof t !== 'object') return errs.push(`${where}: 缺少队伍`);
    need(isStr(t.id) && isStr(t.faction), `${where}: 缺 id/faction`);
    need(isInt(t.soldiers) && t.soldiers >= 0, `${where}: 兵数非法 ${t.soldiers}`);
    need(Array.isArray(t.generals) && t.generals.length >= 1 && t.generals.length <= rules.max_generals, `${where}: 武将数非法`);
    (t.generals || []).forEach(g => general(g, where));
    need(Array.isArray(t.items) && t.items.length <= rules.item_slots, `${where}: 物品栏非法`);
    (t.items || []).forEach(i => need(items.has(i), `${where}: 未知物品 ${i}`));
    const p = t.position;
    need(p && isNum(p.x) && isNum(p.y) && p.x >= 0 && p.y >= 0 && p.x <= W && p.y <= H, `${where}: 位置非法`);
  };

  need(s && typeof s === 'object', '存档不是对象');
  if (errs.length) return errs;
  need(isInt(s.saveVersion), '缺 saveVersion');
  need(isNum(s.gameTimeMs) && s.gameTimeMs >= 0, '缺 gameTimeMs');
  const st = s.state;
  need(st && typeof st === 'object', '缺 state');
  if (st) {
    need(isInt(st.points) && st.points >= 0, `点数非法: ${st.points}`);
    need(isInt(st.gachaDraws) && st.gachaDraws >= 0, '抽卡次数非法');
    need(Array.isArray(st.freePool) && st.freePool.every(id => known.has(id)), '自由池非法');
    need(Array.isArray(st.pendingGenerals), '待安排队列非法');
    (st.pendingGenerals || []).forEach((p, i) => general(p?.general, `pendingGenerals[${i}]`));
    need(Array.isArray(st.battleLog), '战报非法');
    need(Array.isArray(st.captured ?? []), '俘获记录非法');
    (st.captured || []).forEach((g, i) => general(g, `captured[${i}]`));
  }
  need(s.player && typeof s.player === 'object', '缺 player');
  if (s.player) {
    team(s.player.team, 'player');
    need(s.player.team?.is_player === true, 'player.team 不是玩家队');
    need(s.player.team?.generals?.some(g => g.id === balance.hero?.id), '玩家队里没有主角');
  }
  need(Array.isArray(s.ai), '缺 ai 列表');
  (s.ai || []).forEach((a, i) => team(a?.team, `ai[${i}]`));
  const ids = [s.player?.team?.id, ...(s.ai || []).map(a => a?.team?.id)];
  need(new Set(ids).size === ids.length, '队伍 id 重复');
  need(s.names && Array.isArray(s.names.pool) && isInt(s.names.n), '缺 names');
  need(s.spawn && isInt(s.spawn.counter), '缺 spawn');
  need(!s.timers || Object.values(s.timers).every(isNum), 'timers 非法');
  need(isNum(s.player?.invincibleUntil ?? 0) && isNum(s.player?.graceUntil ?? 0), 'player 计时非法');
  return errs;
}

/**
 * 文本 → 已迁移、已校验的存档。失败抛 SaveError(code)：
 *   empty | corrupt（JSON 坏/结构坏）| too_new（来自更新版本的游戏）| incompatible（无法迁移 / 地图种子不同）
 * 成功返回 { save, warnings }；数值版本不同只给 warning（引用校验通过即可继续）。
 */
export function parseSave(text, { balance, mapSeed, migrations = MIGRATIONS }) {
  if (text === null || text === undefined || text === '') throw new SaveError('empty', '没有存档');
  let raw;
  try { raw = JSON.parse(text); } catch { throw new SaveError('corrupt', '存档损坏（无法解析）'); }
  if (!raw || typeof raw !== 'object' || !isInt(raw.saveVersion)) throw new SaveError('corrupt', '存档损坏（缺少版本号）');
  if (raw.saveVersion > SAVE_VERSION) throw new SaveError('too_new', `存档来自更新版本的游戏（存档 v${raw.saveVersion}，当前 v${SAVE_VERSION}）`);
  const save = migrate(raw, migrations);
  if (mapSeed !== undefined && save.mapSeed !== mapSeed) throw new SaveError('incompatible', `地图不同（存档种子 ${save.mapSeed}，当前 ${mapSeed}）`);
  const errs = validateSave(save, balance);
  if (errs.length) throw new SaveError('corrupt', `存档数据不完整：${errs.slice(0, 3).join('；')}${errs.length > 3 ? ` 等 ${errs.length} 处` : ''}`);
  const warnings = [];
  const bv = balance._meta?.version ?? null;
  if (save.balanceVersion !== bv) warnings.push(`存档来自数值 v${save.balanceVersion}，当前 v${bv}，已按当前数值继续`);
  return { save, warnings };
}

// ---------------- 存储（接口见 src/platform/storage.js：get / set / remove）----------------
export function writeSave(save, storage, key = SAVE_KEY) {
  if (!storage) return false;
  try { storage.set(key, serialize(save)); return true; } catch (e) { console.warn('[save] 写入失败', e); return false; }
}

export function readSaveText(storage, key = SAVE_KEY) {
  try { return storage ? storage.get(key) : null; } catch { return null; }
}

/** 读档：返回 {ok:true, save, warnings} 或 {ok:false, code, message}，永不抛异常 */
export function loadSave(ctx, storage, key = SAVE_KEY) {
  try {
    const r = parseSave(readSaveText(storage, key), ctx);
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, code: e.code ?? 'corrupt', message: e.code ? e.message : `存档无法读取：${e.message}` };
  }
}

export function clearSave(storage, key = SAVE_KEY) {
  try { storage?.remove(key); } catch { /* ignore */ }
}

export const hasSave = (storage, key = SAVE_KEY) => readSaveText(storage, key) !== null;

// ---------------- AI 记忆（游戏时钟上的绝对时间，原样保存）----------------
/** 只保存决策记忆；过期的忽略项丢弃；personality 由阵营配置重新推出，nextReplan 不保存 */
export function memToSave(mem, nowMs) {
  const nowS = nowMs / 1000, ignore = {};
  for (const [id, until] of Object.entries(mem?.ignore || {})) if (until > nowS) ignore[id] = until;
  return { state: mem?.state ?? 'wander', targetId: mem?.targetId ?? null, since: mem?.since ?? nowS, ignore, idleUntil: mem?.idleUntil ?? 0 };
}

export function memFromSave(m) {
  return { state: m?.state ?? 'wander', targetId: m?.targetId ?? null, since: m?.since ?? 0, ignore: { ...(m?.ignore || {}) }, idleUntil: m?.idleUntil ?? 0, nextReplan: 0 };
}

/** 存档里的 state → 运行时 gameState（缺省字段补默认值） */
export function restoreGameState(s, base) {
  return { ...base, ...structuredClone(s) };
}
