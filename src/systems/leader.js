/**
 * v0.6 统帅规则（leader_v06，纯函数，无 Phaser）。所有原来按「主将 = 统率最高」结算的地方都调用这里的 4 个函数：
 *   getLeader(team)      玩家队 = 主角（永远）；敌队 = A3：将才分 统率+武力 最高，并列取统率高，再并列取数组靠前；
 *                        名将军（leader.named_armies）固定 = 名将本人（initial_teams 里 generals[0]），名将不在队时按将才分
 *   leaderLead(team)     玩家 = L = 主角统率 + sub_lead_k × Σ副将统率（不封顶，A1）；敌队 = 统帅统率
 *   affinityBonus(team)  玩家 = 任一副将擅长当前兵种 → M + sub_affinity_bonus（不叠加，主角没有擅长，A4）；敌队 = 统帅擅长 → M + enemy_affinity_bonus
 *   recalcLeader(team)   成员 / 属性变化、补兵、读档后调用：缓存 team.leaderId（★ 统帅），并按 {统帅名}军 刷新队名（nameFn）
 *   speedLead(team)      统率加速用：玩家 min(L, speed_L_cap)；敌队 = 统帅统率
 * 没有 v0.6 配置（balance.v06 缺失，如只用 v0.4 / v0.5 配置的旧单测）时回落到旧规则：主将 = 统率最高（并列靠前），擅长看主将。
 */
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

export const heroIdOf = balance => balance.hero?.id ?? 'hero';
export const isPlayerTeam = (team, balance) => !!(team.is_player ?? team.faction === balance.player_faction?.id);

/** 旧规则（v0.3–v0.5）：统率最高者，并列取数组靠前 */
function legacyMain(gs) {
  let best = gs[0];
  for (const g of gs) if (g.lead > best.lead) best = g;
  return best;
}

/** 名将军的名将 id（initial_teams 定义的 generals[0]）；不是名将军 → null */
export function namedGeneralId(team, balance) {
  const L = balance.v06?.leader;
  if (!L || !L.named_armies.includes(team.id)) return null;
  const def = balance.initial_teams?.find(t => t.id === team.id);
  const ref = def?.generals?.[0];
  return typeof ref === 'string' ? ref : ref?.id ?? null;
}

/** A3：将才分最高（enemy_score 各项之和），并列统率高，再并列数组靠前 */
export function scoreLeader(gs, balance) {
  const keys = balance.v06?.leader?.enemy_score ?? ['lead', 'str'];
  const score = g => sum(keys, k => g[k] ?? 0);
  let best = gs[0];
  for (const g of gs) {
    const d = score(g) - score(best);
    if (d > 0 || (d === 0 && g.lead > best.lead)) best = g;
  }
  return best;
}

export function getLeader(team, balance) {
  const gs = team.generals ?? [];
  if (!gs.length) return undefined;
  if (!balance.v06) {
    const idx = balance.team_rules?.main_general_index;
    return Number.isInteger(idx) ? gs[idx] ?? gs[0] : legacyMain(gs);
  }
  if (isPlayerTeam(team, balance)) return gs.find(g => g.id === heroIdOf(balance)) ?? scoreLeader(gs, balance);
  const nid = namedGeneralId(team, balance);
  const named = nid && gs.find(g => g.id === nid);
  return named || scoreLeader(gs, balance);
}

/** 副将 = 统帅以外的武将 */
export function deputiesOf(team, balance) {
  const l = getLeader(team, balance);
  return (team.generals ?? []).filter(g => g !== l);
}

export function leaderLead(team, balance) {
  const l = getLeader(team, balance);
  if (!l) return 0;
  if (!balance.v06 || !isPlayerTeam(team, balance)) return l.lead;
  return l.lead + balance.v06.leader.sub_lead_k * sum(deputiesOf(team, balance), g => g.lead);
}

/** 统率加速用的统率：玩家 L 封顶 speed_L_cap；敌队统帅统率（没有武将 = 50，即不加不减） */
export function speedLead(team, balance) {
  if (!(team.generals ?? []).length) return 50;
  const L = leaderLead(team, balance);
  return balance.v06 && isPlayerTeam(team, balance) ? Math.min(L, balance.v06.leader.speed_L_cap) : L;
}

export function affinityBonus(team, balance) {
  const af = balance.v05?.units?.affinity; if (!af || !team.unit) return 0;
  if (balance.v06 && isPlayerTeam(team, balance)) {
    return deputiesOf(team, balance).some(g => af.table[g.id] === team.unit) ? balance.v06.leader.sub_affinity_bonus : 0;
  }
  const l = getLeader(team, balance);
  const bonus = balance.v06 ? balance.v06.leader.enemy_affinity_bonus : af.m_bonus;
  return l && af.table[l.id] === team.unit ? bonus : 0;
}

/** 擅长当前兵种、正在生效的武将（显示用）：玩家 = 第一名擅长的副将；敌队 = 统帅 */
export function affinityGeneral(team, balance) {
  const af = balance.v05?.units?.affinity; if (!af || !team.unit || !affinityBonus(team, balance)) return null;
  if (balance.v06 && isPlayerTeam(team, balance)) return deputiesOf(team, balance).find(g => af.table[g.id] === team.unit) ?? null;
  return getLeader(team, balance) ?? null;
}

/** 成员 / 属性变化后：缓存 leaderId，按需刷新队名（nameFn(team) → 名字；玩家队名固定） */
export function recalcLeader(team, balance, nameFn = null) {
  const l = getLeader(team, balance);
  team.leaderId = l?.id ?? null;
  if (nameFn && !team.fixedName) team.name = nameFn(team);
  return l;
}

/** 主角每进入新章节：统率 +lead、武力 +str（上限 cap）。fromCh → toCh 之间每章一次；返回实际加成 */
export function growHero(team, balance, chapters = 1) {
  const G = balance.v06?.leader?.hero_growth; if (!G || chapters <= 0) return null;
  const h = (team.generals ?? []).find(g => g.id === heroIdOf(balance)); if (!h) return null;
  const before = { lead: h.lead, str: h.str };
  h.lead = Math.min(G.cap, h.lead + G.lead * chapters);
  h.str = Math.min(G.cap, h.str + G.str * chapters);
  return { lead: h.lead - before.lead, str: h.str - before.str };
}
