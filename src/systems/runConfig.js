/**
 * v0.5 一局的配置（纯函数，无 Phaser）。
 *   applyRunConfig(balance_v0.4, run_v05) → 游戏用的 balance：1600 地图 + 城池布局、密度（10 队 / 12 s / 400–800 px）、
 *     视野/游荡半径、成长调参（抽卡价、点数、收编）、克制物品并入物品表；原 v0.4 字段不删（v0.4 单测仍用原文件）。
 *   chapterIndexAt / chapterOf：按局内时间（秒）查章节（20 分钟局 0/4/9/14 分钟）
 */
const px2tile = (v, T) => Math.floor(v / T);
const tileCenter = (t, T) => t * T + T / 2;

export function applyRunConfig(b, run) {
  const out = structuredClone(b);
  const T = b.map.tile_px, S = run.map.map_px, scale = S / b.map.width_px;
  const tiles = Math.round(S / T);
  out.map = { ...b.map, tiles_w: tiles, tiles_h: tiles, width_px: tiles * T, height_px: tiles * T, blob_scale: scale * scale };
  // 城池：fast_pace.map.layout（像素）→ 格
  out.cities = b.cities.map(c => {
    const p = run.map.layout[c.id]; if (!p) return c;
    const tx = px2tile(p[0], T), ty = px2tile(p[1], T);
    return { ...c, tile: { x: tx, y: ty }, px: { x: tileCenter(tx, T), y: tileCenter(ty, T) } };
  });
  const cityPx = Object.fromEntries(out.cities.map(c => [c.id, c.px]));
  out.ai = { ...b.ai, vision_px: run.density.vision_px, wander_radius_px: run.density.ai_wander_r_px,
    factions: b.ai.factions.map(f => (f.home_city && cityPx[f.home_city] ? { ...f, home: { ...cityPx[f.home_city] } } : f)) };
  const start = cityPx[b.player_faction.start_city] ?? b.player_faction.start;
  out.player_faction = { ...b.player_faction, start: { ...start } };
  out.initial_teams = b.initial_teams.map(t => {
    if (t.faction === b.player_faction.id) return { ...t, position: { ...start } };
    if (t.position && typeof t.position === 'object') return { ...t, position: { x: Math.round(t.position.x * scale), y: Math.round(t.position.y * scale) } };
    return t;
  });
  out.spawn = { ...b.spawn, max_ai_teams: run.density.max_ai_teams, respawn_interval_s: run.density.respawn_s, dist_from_player_px: run.density.spawn_dist_px,
    power_vs_player: run.chapters[0].spawn_power_vs_player };
  const g = run.growth;
  out.gacha = { ...b.gacha, cost_base: g.gacha_cost.base, cost_step: g.gacha_cost.step, cost_cap: g.gacha_cost.cap };
  out.rewards = { ...b.rewards, points_base: g.points.base, points_per_enemy_power: g.points.per_power, recruit_base: g.recruit_base };
  // 克制物品（units.counter_items）并入物品表；效果 dmg_taken_from / scout_px 由战斗、显示读取
  const have = new Set(b.items.map(i => i.id));
  out.items = [...b.items, ...run.units.counter_items.filter(i => !have.has(i.id)).map(i => ({ id: i.id, name: i.name, effect: i.effect }))];
  out.v05 = run;
  out._meta = { ...b._meta, version: `${b._meta.version}+v${run._source.version}` };
  return out;
}

/** 局内时间 tS（秒）→ 章节下标 0..3 */
export function chapterIndexAt(tS, run) {
  let i = 0;
  run.chapters.forEach((c, k) => { if (tS >= c.start_s) i = k; });
  return i;
}
export const chapterOf = (tS, run) => run.chapters[chapterIndexAt(tS, run)];

/** 本章刷新战力区间（群雄模式 +spawn_power_add） */
export function spawnPowerRange(chIdx, run, hard = false) {
  const [lo, hi] = run.chapters[chIdx].spawn_power_vs_player;
  const add = hard ? (run.meta.unlocks.find(u => u.id === 'hard_mode')?.spawn_power_add ?? 0) : 0;
  return [lo + add, hi + add];
}
/** 群雄模式克制倍率加成 */
export const counterAddOf = (run, hard) => (hard ? (run.meta.unlocks.find(u => u.id === 'hard_mode')?.counter_mult_add ?? 0) : 0);

/** 克制 unit 的兵种（counters：X 克 counters[X]）→ 反查“谁克 u” */
export function counterOf(u, counters) {
  return Object.keys(counters).find(k => counters[k] === u) ?? null;
}
