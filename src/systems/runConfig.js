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
    if (t.position && typeof t.position === 'object') {
      // [解读] 坐标按 0.5 缩放后，初始黄巾离玩家出生点太近（≈150 px，游荡就会撞上）；推到至少 spawn_dist_px[0] 外，
      // 保证开局第一战是 20 s 的“来袭”（fast_pace.first_battle）
      let x = t.position.x * scale, y = t.position.y * scale;
      const dx = x - start.x, dy = y - start.y, d = Math.hypot(dx, dy), min = run.density.spawn_dist_px[0];
      if (d < min) { const k = min / Math.max(1e-9, d); x = start.x + dx * k; y = start.y + dy * k; }
      return { ...t, position: { x: Math.round(Math.min(S - T, Math.max(T, x))), y: Math.round(Math.min(S - T, Math.max(T, y))) } };
    }
    return t;
  });
  out.spawn = { ...b.spawn, max_ai_teams: run.density.max_ai_teams, respawn_interval_s: run.density.respawn_s, dist_from_player_px: run.density.spawn_dist_px,
    power_vs_player: run.chapters[0].spawn_power_vs_player };
  const g = run.growth;
  // gacha_v05.pool：属性 50 / 物品 25 / 兵种令 10 / 操练 5 / 武将 10（item_source 说明文字 → 规则名）
  const pool = (run.gacha_pool ?? b.gacha.pool).map(e => (e.type === 'item' ? { ...e, item_source: 'items_all_uniform' } : { ...e }));
  out.gacha = { ...b.gacha, pool, cost_base: g.gacha_cost.base, cost_step: g.gacha_cost.step, cost_cap: g.gacha_cost.cap };
  out.rewards = { ...b.rewards, points_base: g.points.base, points_per_enemy_power: g.points.per_power, recruit_base: g.recruit_base,
    // polish_merged.1：黄巾头目不可俘获（generic_capturable = false）
    capture_rules: { ...b.rewards.capture_rules, ...(run.capture ?? {}) } };
  // 克制物品（units.counter_items）并入物品表；效果 dmg_taken_from / scout_px 由战斗、显示读取
  const have = new Set(b.items.map(i => i.id));
  out.items = [...b.items, ...run.units.counter_items.filter(i => !have.has(i.id)).map(i => ({ id: i.id, name: i.name, effect: i.effect }))];
  out.v05 = run;
  out._meta = { ...b._meta, version: `${b._meta.version}+v${run._source.version}` };
  return out;
}

/**
 * v0.6（balance_v0.6.json 定稿 → data/v06.json）叠加到 v0.5 balance 上：抽卡价、名册上限、玩家出生点；
 * 全部 v0.6 规则挂在 out.v06（gacha / leader / roster / city），程序侧【假设】在 out.v06.prog（data/assumptions.json → v06）。
 */
export function applyV06(b, v06, prog = {}) {
  const out = structuredClone(b);
  out.v06 = { ...structuredClone(v06), prog: structuredClone(prog) };
  const c = v06.gacha.cost;
  out.gacha = { ...out.gacha, cost_base: c.base, cost_step: c.step, cost_cap: c.cap };
  out.team_rules = { ...out.team_rules, max_generals: v06.roster.max_generals };
  // 程序侧城池参数（assumptions.v06.values.city，定稿没写的）补进 v06.city；不覆盖定稿已有的键
  if (prog.city) for (const [k, v] of Object.entries(prog.city)) if (!(k in out.v06.city)) out.v06.city[k] = structuredClone(v);
  // 【假设】洛阳开局是黄巾守军的城：玩家出生点挪到洛阳外 start_offset_px（不然一出生就在敌城里）
  const off = prog.start_offset_px;
  if (off) {
    const p = out.player_faction.start, S = out.map.width_px, T = out.map.tile_px;
    const start = { x: p.x + off.x, y: Math.min(S - T, Math.max(T, p.y + off.y)) };
    out.player_faction = { ...out.player_faction, start };
    out.initial_teams = out.initial_teams.map(t => (t.faction === out.player_faction.id ? { ...t, position: { ...start } } : t));
  }
  out._meta = { ...out._meta, version: `${out._meta.version}+v${v06._source.version}` };
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
