/**
 * 抽卡（纯逻辑，无 Phaser；单测见 tests/gacha.test.js）。
 * 规则全部来自 balance v0.4：gacha（单价、pool[].weight/attr_amount/tier/item_source、empty_tier_fallback、attr_upgrade、
 * item_rule、general_rule）、gacha_ui（allowed_when、deduct_timing、文案模板）、roster（满编队列、duplicate_general）。
 * 不读 v0.3 已删除的重叠字段（gacha.overlap_note）。配置没有保底（pity）字段 → 不实现保底。
 *
 * 用法：
 *   const chk = canPull(state, team, balance, {inBattle})    // {ok, cost, reason, text}
 *   const res = pull(state, team, balance, rng)              // 先扣点 + 次数+1，再掷结果；可能需要后续选择
 *   res.next: null | 'choose_general'（属性提升选人）| 'item_full'（物品栏满）| 'roster_full'（满编待安排）
 *   applyAttrUpgrade(team, generalIndex, amount, balance, rng) / resolveItemFull(...)
 */
import { addGeneralOrQueue } from './roster.js';

const ATTRS = ['lead', 'str', 'int', 'cha'];
export const ATTR_NAMES = { lead: '统率', str: '武力', int: '智力', cha: '魅力' };
const POOL_NAMES = { item: '物品' };
/** 卡池条目 → 显示名（属性卡数值、武将档位都读配置） */
export function typeName(entry) {
  if (!entry) return '';
  if (entry.attr_amount !== undefined) return `属性 +${entry.attr_amount}`;
  if (entry.tier) return `${entry.tier} 级武将`;
  return POOL_NAMES[entry.type] ?? entry.type;
}
export const poolEntry = (balance, type) => balance.gacha.pool.find(e => e.type === type);
/** 属性卡加多少：pool[].attr_amount（v0.4） */
export function attrAmount(balance, type) {
  const v = poolEntry(balance, type)?.attr_amount;
  if (!Number.isFinite(v)) throw new Error(`卡池 ${type} 缺少 attr_amount`);
  return v;
}
/** 武将档位为空时改出的卡类型：gacha.empty_tier_fallback（v0.4）；roster.duplicate_general 文案写的是 attr_big */
export const emptyTierFallback = balance => balance.gacha.empty_tier_fallback ?? 'attr_big';
const DUPLICATE_GENERAL_TYPE = 'attr_big';

/** 文案模板：把 {键} 换成 vars[键] */
export function fmt(tpl, vars) { return tpl.replace(/\{([^}]+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)); }
const T = (balance, key, fallback) => balance.gacha_ui?.result_text?.[key] ?? fallback;

/** cost = min(cost_base + cost_step × 已抽次数, cost_cap) */
export function pullCost(draws, gacha) {
  return Math.min(gacha.cost_base + gacha.cost_step * draws, gacha.cost_cap);
}

/** 概率表：[{type, weight, p}] */
export function oddsTable(gacha) {
  const total = gacha.pool.reduce((s, e) => s + e.weight, 0);
  return gacha.pool.map(e => ({ type: e.type, weight: e.weight, p: e.weight / total, effect: e.effect }));
}

export function weightedPick(pool, rng) {
  const total = pool.reduce((s, e) => s + e.weight, 0);
  let r = rng() * total;
  for (const e of pool) { if (r < e.weight) return e; r -= e.weight; }
  return pool[pool.length - 1];
}


/** 自由池中某档位的名将 id */
export function freeByTier(state, balance, tier) {
  const byId = Object.fromEntries(balance.generals.map(g => [g.id, g]));
  return state.freePool.filter(id => byId[id]?.tier === tier);
}

/** gacha_ui.allowed_when：不在战斗中且没有未处理的 pending_generals；draw_button_disabled_when：points < cost */
export function canPull(state, team, balance, { inBattle = false } = {}) {
  const cost = pullCost(state.gachaDraws, balance.gacha);
  if (inBattle) return { ok: false, cost, reason: 'battle', text: '战斗中不能抽卡' };
  if (state.pendingGenerals?.length) return { ok: false, cost, reason: 'pending', text: '有待安排的武将，请先处理' };
  if (state.points < cost) {
    const tpl = balance.gacha_ui?.insufficient_text ?? '点数不足：下一抽需要 {cost} 点，还差 {lack} 点';
    return { ok: false, cost, reason: 'points', text: fmt(tpl, { cost, lack: cost - state.points }) };
  }
  return { ok: true, cost, reason: null, text: '' };
}

/** 属性提升可选目标（四项全满的不可选） */
export function attrTargets(team, balance) {
  const cap = balance.gacha.attr_cap;
  return team.generals.map((g, i) => ({ g, i })).filter(({ g }) => ATTRS.some(a => g[a] < cap)).map(({ i }) => i);
}

/**
 * 给第 index 名武将提升属性：在未满 attr_cap 的属性中等概率随机 1 项（等价于 v0.2“满则在其余未满中重抽”），超出截断。
 */
export function applyAttrUpgrade(team, index, amount, balance, rng) {
  const cap = balance.gacha.attr_cap;
  const g = team.generals[index];
  const open = ATTRS.filter(a => g[a] < cap);
  if (!open.length) return null;
  const attr = open[Math.floor(rng() * open.length)];
  const old = g[attr];
  g[attr] = Math.min(cap, old + amount); // overflow：超过 cap 的部分截断
  const text = fmt(T(balance, 'attr', '{武将} {属性} {旧值} → {新值}'), { 武将: g.name, 属性: ATTR_NAMES[attr], 旧值: old, 新值: g[attr] });
  return { general: g, index, attr, old, new: g[attr], text };
}

/**
 * 抽一次。会修改 state（points、gachaDraws、freePool、pendingGenerals）与 team（直接入队的武将 / 物品 / 自动属性提升）。
 * 返回 { cost, type, entry, fallback, general, item, attr, refund, next, text }
 */
export function pull(state, team, balance, rng, ctx = {}) {
  const g = balance.gacha;
  const chk = canPull(state, team, balance, ctx);
  if (!chk.ok) throw new Error(chk.text);
  // 扣点与次数在掷结果之前（之后的选择不能撤销抽卡）
  state.points -= chk.cost;
  state.gachaDraws += 1;

  const entry = weightedPick(g.pool, rng);
  const res = { cost: chk.cost, type: entry.type, rolledType: entry.type, entry, fallback: null, refund: 0, next: null, text: '' };

  const tier = entry.tier;
  if (tier) {
    const cands = freeByTier(state, balance, tier);
    if (!cands.length) {
      res.fallback = 'empty_tier'; // gacha.empty_tier_fallback：该档自由池为空 → 改出配置指定的卡
      res.type = emptyTierFallback(balance);
    } else {
      const id = cands[Math.floor(rng() * cands.length)]; // general_rule：档内等概率，移出自由池
      state.freePool = state.freePool.filter(x => x !== id);
      const inTeam = team.generals.findIndex(x => x.id === id);
      if (inTeam >= 0) { // roster.duplicate_general：已在玩家队中 → 按 attr_big 给该武将
        res.fallback = 'duplicate_general'; res.type = DUPLICATE_GENERAL_TYPE; res.amount = attrAmount(balance, res.type);
        res.attr = applyAttrUpgrade(team, inTeam, res.amount, balance, rng);
        res.text = res.attr ? res.attr.text : '';
        return res;
      }
      const base = balance.generals.find(x => x.id === id);
      const general = { id: base.id, name: base.name, tier: base.tier, lead: base.lead, str: base.str, int: base.int, cha: base.cha };
      res.general = general;
      const r = addGeneralOrQueue(state, team, general, { source: 'gacha', from: '抽卡' }, balance);
      res.next = r.joined ? null : 'roster_full';
      res.text = fmt(T(balance, r.joined ? 'general' : 'general_pending', r.joined ? '{武将}（{档}）加入队伍' : '{武将}（{档}）待安排：队伍已满'),
        { 武将: general.name, 档: general.tier });
      return res;
    }
  }

  if (poolEntry(balance, res.type)?.attr_amount !== undefined) {
    res.amount = attrAmount(balance, res.type);
    const targets = attrTargets(team, balance);
    if (!targets.length) { // attr_upgrade.all_full：全队四项全满 → 返还 duplicate_item_refund_points
      res.refund = g.duplicate_item_refund_points;
      state.points += res.refund;
      res.text = `队内武将属性已全满，返还 ${res.refund} 点`;
      return res;
    }
    if (targets.length === 1) { // 只有 1 名可选时自动选中
      res.attr = applyAttrUpgrade(team, targets[0], res.amount, balance, rng);
      res.text = res.attr.text;
      return res;
    }
    res.targets = targets;
    res.next = 'choose_general';
    res.text = `属性 +${res.amount}：请选择一名武将`;
    return res;
  }

  // item：从物品表等概率抽 1 件
  // pool[].item_source = items_all_uniform：整张 items 表等概率（含已拥有的，抽到按 item_rule.duplicate 返还）
  const src = poolEntry(balance, 'item')?.item_source ?? 'items_all_uniform';
  if (src !== 'items_all_uniform') throw new Error(`不支持的 item_source: ${src}`);
  const item = balance.items[Math.floor(rng() * balance.items.length)];
  res.item = item;
  if (team.items.includes(item.id)) { // item_rule.duplicate
    res.refund = g.duplicate_item_refund_points;
    state.points += res.refund;
    res.text = fmt(T(balance, 'item_refund', '已拥有 {物品}，返还 {n} 点'), { 物品: item.name, n: res.refund });
  } else if (team.items.length < balance.team_rules.item_slots) { // item_rule.slots_free
    team.items.push(item.id);
    res.text = fmt(T(balance, 'item', '获得 {物品}：{效果}'), { 物品: item.name, 效果: describeItem(item) });
  } else {
    res.next = 'item_full';
    res.text = `物品栏已满：丢弃一件旧物品换 ${item.name}，或放弃`;
  }
  return res;
}

/**
 * item_rule.slots_full（ITEM_FULL）：discardIndex = 丢弃的旧物品下标换新；null = 放弃新物品并返还 duplicate_item_refund_points
 */
export function resolveItemFull(state, team, item, discardIndex, balance) {
  if (discardIndex === null || discardIndex === undefined) {
    const refund = balance.gacha.duplicate_item_refund_points;
    state.points += refund;
    return { refund, text: refund ? `放弃 ${item.name}，返还 ${refund} 点` : `放弃 ${item.name}` };
  }
  const old = team.items[discardIndex];
  team.items[discardIndex] = item.id;
  const oldName = balance.items.find(i => i.id === old)?.name ?? old;
  return { refund: 0, discarded: old, text: `丢弃 ${oldName}，获得 ${item.name}` };
}

export function describeItem(item) {
  const e = item.effect || {};
  const parts = [];
  if (e.power_pct) parts.push(`战力 +${Math.round(e.power_pct * 100)}%`);
  if (e.speed_pct) parts.push(`速度 +${Math.round(e.speed_pct * 100)}%`);
  if (e.soldier_cap) parts.push(`兵力上限 +${e.soldier_cap}`);
  if (e.loss_reduction) parts.push(`损兵减免 +${Math.round(e.loss_reduction * 100)}%`);
  if (e.recruit_pct) parts.push(`收编率 +${Math.round(e.recruit_pct * 100)}%`);
  return parts.join('，') || '无效果';
}
