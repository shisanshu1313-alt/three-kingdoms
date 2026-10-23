/**
 * 存档（纯逻辑，无 Phaser / 浏览器依赖；单测见 tests/save.test.js）。
 * 读写通过存储接口 storage = { get, set, remove }（src/platform/storage.js），由调用方传入。
 *
 * 存档结构（saveVersion 3；所有计时都用游戏时钟 core/GameClock.js）：
 * {
 *   saveVersion, balanceVersion, mapSeed, savedAt(ISO 真实时间，仅显示用), reason,
 *   gameTimeMs,                       // 游戏时钟 now；下面所有时间都是这个时钟上的绝对时刻
 *   state:  { points, gachaDraws, freePool, pendingGenerals, captured, battleLog, battles,
 *             gachaPending },          // 抽卡后还没做的选择（选武将 / 物品栏满），读档后重新弹出
 *   battles: [{ a, b, result, startAt, endAt, lossOf, startSoldiers }], // 进行中的战斗（结果开战时已掷好）
 *   player: { team, mainGeneralId, invincibleUntil, graceUntil },
 *   ai:     [{ team, mem: { state, targetId, since(秒), ignore: {id: 截止秒}, idleUntil }, graceUntil }],
 *   spawn:  { counter },              // 补充刷新已刷支数（决定 id）
 *   timers: { respawn, autosave },    // 各定时器下一次触发的游戏时间
 *   names:  { pool, n },              // 黄巾头目名字池剩余 + 「黄巾头目N」序号
 *   rng:    { team, gacha, combat },  // 种子随机数流状态：读档后抽卡/战斗结果不会重掷（AI 游荡、补充刷新仍用 Math.random）
 *   pairCooldowns: [[pairKey, 截止ms]],          // v0.4（v0.5 原型不再写，留空数组）
 *   combat: { state: melee 战斗状态, mem: {aiId: 战术记忆} } | null,  // v0.5 原型：实时战斗快照，读档原样继续
 *   camera: { zoom }
 * }
 * 读档时游戏时钟从 gameTimeMs 继续，所以截止时间原样还原。
 * team = balance.team_example 结构（+ name/home/state）。
 * 武将（v3）：名将/主角只存 { id, growth: {属性: 成长值} }，基础属性读档时取当前配置（策划改数值会生效）；
 *            黄巾头目等没有配置的武将存完整属性 { id, name, generic: true, lead, str, int, cha }。
 *            存档对象（makeSave 的结果）是编码后的；parseSave 返回解码后的运行时形式（完整属性）。
 * v1（存剩余时长）→ v2 见 MIGRATIONS[1]；v2（完整属性）→ v3（成长值）见 MIGRATIONS[2]。
 */

import runCfg from '../data/run_v05.json' with { type: 'json' };
import { createCities, PLAYER } from './city.js';
/**
 * v4（v0.5 roguelike，save_v05）：单槽 run 存档（键 sanguo-run-v1），多了 run（runId / runSeed / 章节 / 主角 HP …）
 * 和 combat（战斗快照）。v3 及更早（v0.4 键 sanguo-save）不迁移：首次启动改名为 sanguo-save-legacy 归档，不读取。
 */
export const SAVE_VERSION = 5;
export const SAVE_KEY = runCfg.save.keys.run;
export const META_KEY = runCfg.save.keys.meta;
export const LEGACY_KEY = runCfg.save.keys.legacy_from;
export const LEGACY_ARCHIVE_KEY = runCfg.save.keys.legacy_to;

/** save_v05.keys.legacy：旧版（v0.4）存档改名归档，不读取。返回是否归档了旧档 */
export function archiveLegacySave(storage) {
  try {
    const t = storage?.get(LEGACY_KEY);
    if (t === null || t === undefined) return false;
    storage.set(LEGACY_ARCHIVE_KEY, t);
    storage.remove(LEGACY_KEY);
    return true;
  } catch { return false; }
}

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
  },
  /** v2（完整属性）→ v3（id + 成长值）：成长 = 存档属性 − 当前配置基础值，负数按 0 */
  2: (s, { balance }) => {
    const out = { ...s, saveVersion: 3 };
    const conv = g => (g && typeof g === 'object' ? encodeGeneral(g, balance, { clampNegative: true }) : g);
    walkGenerals(out, conv);
    return out;
  },
  /**
   * v4（v0.5）→ v5（v0.6：抽 4 选 1、主城、主角成长）【假设 city_old_saves】
   *   城池：洛阳设为无主空城（没有守军），各大本营照常，城防按当前章节；没有主城、存放为空
   *   抽卡：抽卡次数沿用 gachaDraws；旧的抽卡待选（gachaPending）丢弃并退还该次点数
   *   主角成长：从当前章节算起（heroGrownCh = run.chapter，不补发已过章节）
   */
  4: (s, { balance }) => {
    const out = structuredClone(s);
    out.saveVersion = 5;
    const st = out.state ?? (out.state = {});
    const gp = st.gachaPending;
    if (gp) { st.points = (st.points ?? 0) + (isInt(gp.cost) ? gp.cost : 0); st.gachaPending = null; }
    st.gacha = { n: st.gachaDraws ?? 0, offer: null, freeRefreshUsed: [0, 0, 0, 0], sinceEpic: 0 };
    st.cityStore = st.cityStore ?? [];
    st.homeCity = null;
    const ch = out.run?.chapter ?? 0;
    if (balance?.v06?.city) st.cities = createCities(balance, { chapter: ch, garrison: false });
    if (out.run) { out.run.heroGrownCh = ch; out.run.city = {}; }
    return out;
  }
};

// ---------------- 武将编码：id + 成长值 ----------------
const ATTR_KEYS = ['lead', 'str', 'int', 'cha'];
export function baseGeneral(balance, id) {
  if (id === balance.hero?.id) return balance.hero;
  return balance.generals.find(g => g.id === id) ?? null;
}

/** 运行时武将 → 存档形式。没有配置基础值的（黄巾头目、未知 id）存完整属性 */
export function encodeGeneral(g, balance, { clampNegative = false } = {}) {
  const base = g.generic ? null : baseGeneral(balance, g.id);
  if (!base) {
    const out = { id: g.id, name: g.name };
    if (g.generic) out.generic = true;
    for (const a of ATTR_KEYS) out[a] = g[a];
    return out;
  }
  const growth = {};
  for (const a of ATTR_KEYS) {
    let d = (g[a] ?? base[a]) - base[a];
    if (clampNegative) d = Math.max(0, d);
    if (d !== 0) growth[a] = d;
  }
  return Object.keys(growth).length ? { id: g.id, growth } : { id: g.id };
}

/** 存档形式 → 运行时武将：基础值取当前配置 + 成长值，截到 [0, attr_cap] */
export function decodeGeneral(e, balance) {
  const cap = balance.gacha.attr_cap;
  const base = e.generic ? null : baseGeneral(balance, e.id);
  if (!base) {
    const out = { id: e.id, name: e.name };
    if (e.generic) out.generic = true;
    for (const a of ATTR_KEYS) out[a] = e[a];
    return out;
  }
  const g = { id: base.id, name: base.name };
  if (base.tier !== undefined) g.tier = base.tier;
  for (const a of ATTR_KEYS) g[a] = Math.min(cap, Math.max(0, base[a] + (e.growth?.[a] ?? 0)));
  return g;
}

/** 对存档里所有武将（玩家/AI 队伍、待安排队列、俘获记录）做同一个变换（原地） */
function walkGenerals(s, fn) {
  const team = t => { if (t && Array.isArray(t.generals)) t.generals = t.generals.map(fn); };
  team(s.player?.team);
  for (const a of s.ai || []) team(a?.team);
  if (s.state) {
    if (Array.isArray(s.state.pendingGenerals)) s.state.pendingGenerals = s.state.pendingGenerals.map(p => (p && p.general ? { ...p, general: fn(p.general) } : p));
    if (Array.isArray(s.state.captured)) s.state.captured = s.state.captured.map(fn);
    if (Array.isArray(s.state.cityStore)) s.state.cityStore = s.state.cityStore.map(fn); // v0.6 主城存放
  }
  return s;
}

export const encodeSave = (save, balance) => walkGenerals(structuredClone(save), g => encodeGeneral(g, balance));
export const decodeSave = (save, balance) => walkGenerals(structuredClone(save), g => decodeGeneral(g, balance));

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
  return encodeSave({
    saveVersion: SAVE_VERSION,
    balanceVersion: balance._meta?.version ?? null,
    mapSeed,
    savedAt: now.toISOString(),
    reason,
    ...JSON.parse(JSON.stringify(snapshot)) // 只保留可 JSON 化的数据（undefined/函数被去掉），保证往返一致
  }, balance);
}

export const serialize = (save) => JSON.stringify(save);

/** 依次执行迁移到当前版本；缺迁移函数 → incompatible */
export function migrate(save, migrations = MIGRATIONS, target = SAVE_VERSION, ctx = {}) {
  let s = save;
  while (s.saveVersion < target) {
    const fn = migrations[s.saveVersion];
    if (!fn) throw new SaveError('incompatible', `存档版本 ${s.saveVersion} 无法升级到 ${target}`);
    const from = s.saveVersion;
    s = fn(structuredClone(s), ctx);
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

  // v3 编码形式：名将 { id, growth? }；头目 { id, name, generic, 四项属性 }
  const general = (g, where) => {
    if (!g || typeof g !== 'object') return errs.push(`${where}: 武将格式错误`);
    need(isStr(g.id), `${where}: 武将缺 id`);
    if (g.generic) {
      need(isStr(g.name), `${where}: 头目缺 name`);
      for (const a of ATTRS) need(isNum(g[a]) && g[a] >= 0 && g[a] <= balance.gacha.attr_cap, `${where}.${g.id}.${a} 非法: ${g[a]}`);
    } else {
      need(known.has(g.id), `${where}: 未知武将 ${g.id}`);
      need(g.growth === undefined || (typeof g.growth === 'object' && Object.entries(g.growth).every(([k, v]) => ATTRS.includes(k) && isNum(v))), `${where}.${g.id}: 成长值非法`);
    }
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
    need(st.cityStore === undefined || (Array.isArray(st.cityStore) && st.cityStore.length <= (balance.v06?.roster?.storage_max ?? 0)), '主城存放非法');
    (st.cityStore || []).forEach((g, i) => general(g, `cityStore[${i}]`));
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
  need(s.battles === undefined || (Array.isArray(s.battles) && s.battles.every(b => b && ids.includes(b.a) && ids.includes(b.b) && b.result && isNum(b.endAt))), '进行中的战斗非法');
  // v0.5 实时战斗快照（可选；老存档没有 → 从“无战斗”开始，v0.4 进行中的一次性战斗不再继续）
  const cb = s.combat;
  need(cb == null || (cb.state && typeof cb.state.bodies === 'object' && isNum(cb.state.t) && typeof cb.state.pairs === 'object' &&
    Object.values(cb.state.bodies).every(b => b && ids.includes(b.id) && isNum(b.x) && isNum(b.y) && isNum(b.N0) && isNum(b.raw))), '战斗快照非法');
  // v4：一局的状态（save_v05.fields_add）
  if (s.saveVersion >= 4) {
    const r = s.run;
    need(r && typeof r === 'object' && typeof r.runId === 'string' && isNum(r.heroHp) && isInt(r.chapter) && Array.isArray(r.namedDefeated), '缺 run（一局的状态）');
  }
  // v5（v0.6）：抽卡状态、城池、主城
  if (s.saveVersion >= 5 && st) {
    const g = st.gacha;
    need(g && isInt(g.n) && g.n >= 0 && Array.isArray(g.freeRefreshUsed), '抽卡状态非法');
    const o = g?.offer;
    need(!o || (Array.isArray(o.cards) && o.cards.length >= 1 && o.cards.length <= (balance.v06.gacha.offer_size) && o.cards.every(c => c && isStr(c.kind))), '抽卡 4 选 1 非法');
    const cs = st.cities, cityIds = new Set(balance.cities.map(c => c.id));
    need(cs == null || (typeof cs === 'object' && Object.keys(cs).every(id => cityIds.has(id)) &&
      Object.values(cs).every(c => c && isNum(c.x) && isNum(c.y) && isNum(c.def) && c.def >= 0)), '城池非法'); // null = 读档后按开局生成
    need(st.homeCity == null || (cs?.[st.homeCity]?.owner === PLAYER), '主城非法');
  }
  const gp = s.state?.gachaPending;
  need(!gp || (gp.next === 'choose_general' && isNum(gp.amount)) || (gp.next === 'item_full' && items.has(gp.itemId)) || gp.next === 'choose_unit', '抽卡待选择非法');
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
  const save = migrate(raw, migrations, SAVE_VERSION, { balance });
  if (mapSeed !== undefined && save.mapSeed !== mapSeed) throw new SaveError('incompatible', `地图不同（存档种子 ${save.mapSeed}，当前 ${mapSeed}）`);
  const errs = validateSave(save, balance);
  if (errs.length) throw new SaveError('corrupt', `存档数据不完整：${errs.slice(0, 3).join('；')}${errs.length > 3 ? ` 等 ${errs.length} 处` : ''}`);
  const warnings = [];
  const bv = balance._meta?.version ?? null;
  if (save.balanceVersion !== bv) warnings.push(`存档来自数值 v${save.balanceVersion}，当前 v${bv}，已按当前数值继续`);
  return { save: decodeSave(save, balance), warnings };
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
