/**
 * v0.6 抽卡：付费 → 4 张选 1（gacha_v06，纯逻辑，无 Phaser；单测 tests/gacha_v06.test.js）。
 * 全部数字读 balance.v06.gacha（由 design/balance_v0.6.json 经 scripts/sync-v06.mjs 生成）。
 *
 *   canOpen(state, team, balance, {inBattle})        → {ok, cost, reason, text}（offer 未选完时 ok，reason='resume'）
 *   openDraw(state, team, balance, rng, ctx)         → 扣点、n+1、生成 offer（存在 state.gacha.offer，调用方立即存档）
 *   refreshInfo / refreshOffer(...)                  → 每章首次免费，之后 20 点；每次抽卡最多 1 次；不增加 n
 *   pickCard(state, team, i, balance, rng, opts)     → 结算；需要二级选择时返回 {next:'item_full'|'choose_unit'} 且 offer 保留（可返回改选）
 *   ctx = { chapter, threat: [克制我方的敌兵种…], atS }
 */
import { computePower, soldierCap } from './combat.js';
import { addGeneralOrQueue, pendingPreview } from './roster.js';
import { freeByTier, changeUnit, UNIT_ORDER_UNITS, ATTR_NAMES, describeItem } from './gacha.js';

const ATTRS = ['lead', 'str', 'int', 'cha'];
const G6 = balance => {
  const g = balance.v06?.gacha;
  if (!g) throw new Error('缺少 v0.6 抽卡配置（balance.v06.gacha）');
  return g;
};
export const KIND_NAMES = {
  attr_s: '属性 +小', attr_b: '属性 +大', troops_s: '补兵（小）', troops_b: '补兵（大）', item: '物品', item_counter: '克制物品',
  unit_order: '兵种令', drill: '操练', general_A: 'A 级武将', general_S: 'S 级武将'
};
export const RARITY_NAMES = { common: '普通', rare: '稀有', epic: '高阶' };
const chIdx = (arr, ch) => arr[Math.max(0, Math.min(arr.length - 1, ch | 0))];

export function drawCost(n, balance) {
  const c = G6(balance).cost;
  return Math.min(c.base + c.step * n, c.cap);
}
export function gachaState(state) {
  return (state.gacha ??= { n: state.gachaDraws ?? 0, offer: null, freeRefreshUsed: [0, 0, 0, 0], sinceEpic: 0 });
}

/** 克制我方当前兵种的兵种（counters：X 克 counters[X]）；enemies [{unit, dist}]，range 为侦察距离 */
export function threatUnits(myUnit, enemies, range, counters) {
  const out = new Set();
  for (const e of enemies) if (e.dist <= range && counters[e.unit] === myUnit) out.add(e.unit);
  return [...out];
}

/** 克制物品 → 它防的兵种（item.effect.dmg_taken_from 的键） */
const itemGuards = (balance, id) => Object.keys(balance.items.find(i => i.id === id)?.effect?.dmg_taken_from ?? {});
export const stackCount = (team, balance, kind) => {
  const c = G6(balance).cards[kind];
  const v = kind === 'ep_power' ? team.epPower : team.epCounter;
  const per = kind === 'ep_power' ? c.m_add : c.counter_add;
  return Math.round((v ?? 0) / per);
};
export const troopsAmount = (card, cap) => Math.max(card.min, Math.round(card.pct * cap));

function weightedKey(weights, rng) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (!entries.length) return null;
  let r = rng() * total;
  for (const [k, w] of entries) { if (r < w) return k; r -= w; }
  return entries[entries.length - 1][0];
}
function rollRarity(rng, probs, names) {
  let r = rng();
  for (let i = 0; i < probs.length; i++) { if (r < probs[i]) return names[i]; r -= probs[i]; }
  return names[0];
}

/** 卡池权重：基础 × 章节克制倍率（counter_kinds）× 威胁（unit_order） */
export function kindWeights(rarity, balance, ctx = {}) {
  const g = G6(balance), out = {};
  for (const [k, w] of Object.entries(g.pools[rarity])) {
    let x = w;
    if (g.counter_kinds.includes(k)) x *= chIdx(g.counter_mult_by_chapter, ctx.chapter ?? 0);
    if (k === 'unit_order' && ctx.threat?.length) x *= g.threat_mult;
    out[k] = x;
  }
  return out;
}

/** 生成一张 kind 卡；不合法返回 null。卡：{id, kind, rarity, target, amount, name, text} */
export function makeCard(kind, state, team, balance, rng, ctx = {}) {
  const g = G6(balance), c = g.cards[kind], rarity = c.rarity;
  const base = { kind, rarity };
  if (kind === 'attr_s' || kind === 'attr_b') {
    const cap = g.cards.attr_s.cap;
    const opts = [];
    for (const gen of team.generals) for (const a of ATTRS) if (gen[a] < cap) opts.push({ generalId: gen.id, attr: a });
    if (!opts.length) return null;
    const t = opts[Math.floor(rng() * opts.length)];
    return { ...base, target: t, amount: c.amount };
  }
  if (kind === 'troops_s' || kind === 'troops_b') {
    const cap = soldierCap(team, balance);
    if (team.soldiers >= cap * g.troops_illegal_ratio) return null;
    return { ...base, amount: troopsAmount(c, cap) };
  }
  if (kind === 'item' || kind === 'item_counter') {
    const own = new Set(team.items);
    const cands = c.items.filter(id => !own.has(id) && balance.items.some(i => i.id === id));
    if (!cands.length) return null;
    const w = Object.fromEntries(cands.map(id => [id, kind === 'item_counter' && itemGuards(balance, id).some(u => ctx.threat?.includes(u)) ? c.threat_mult : 1]));
    return { ...base, target: { itemId: weightedKey(w, rng) } };
  }
  if (kind === 'unit_order') return { ...base };
  if (kind === 'drill') return (state.drillUsed ?? 0) < g.drill_max ? { ...base, amount: balance.v05?.units?.drill?.add ?? 0.05 } : null;
  if (kind === 'general_A' || kind === 'general_S') {
    const ids = freeByTier(state, balance, c.tier).filter(id => !team.generals.some(x => x.id === id));
    if (!ids.length) return null;
    return { ...base, target: { generalId: ids[Math.floor(rng() * ids.length)] } };
  }
  if (kind === 'ep_attr') {
    if (!team.generals.some(x => c.attrs.some(a => x[a] < c.cap))) return null;
    return { ...base, name: c.name, amount: c.amount };
  }
  if (kind === 'ep_troops') return { ...base, name: c.name, amount: c.cap_add };
  if (kind === 'ep_power' || kind === 'ep_counter') {
    if (stackCount(team, balance, kind) >= g.epic_stack_max) return null;
    return { ...base, name: c.name, amount: kind === 'ep_power' ? c.m_add : c.counter_add };
  }
  throw new Error(`未知卡类型 ${kind}`);
}

const sameCard = (a, b) => a.kind === b.kind && JSON.stringify(a.target ?? null) === JSON.stringify(b.target ?? null);
/** offer_rules：不重复（同类型 + 同目标）、同类 ≤ max_same_kind、武将卡 ≤ max_general_cards、兵种令 ≤ max_unit_order */
export function passesRules(card, cards, balance) {
  const g = G6(balance);
  if (cards.some(c => sameCard(c, card))) return false;
  if (cards.filter(c => c.kind === card.kind).length >= g.max_same_kind) return false;
  if (card.kind.startsWith('general_') && cards.filter(c => c.kind.startsWith('general_')).length >= g.max_general_cards) return false;
  if (card.kind === 'unit_order' && cards.filter(c => c.kind === 'unit_order').length >= g.max_unit_order) return false;
  return true;
}

/** genOffer：4 个槽位各掷稀有度；每槽最多 max_tries 次，每 downgrade_every 次失败降一级；最后保证至少 1 张成长卡 */
export function genOffer(state, team, balance, rng, ctx = {}) {
  const g = G6(balance), probs = chIdx(g.rarity_by_chapter, ctx.chapter ?? 0), cards = [];
  for (let slot = 0; slot < g.offer_size; slot++) {
    let rar = rollRarity(rng, probs, g.rarities), card = null;
    for (let t = 0; t < g.max_tries && !card; t++) {
      if (t > 0 && t % g.downgrade_every === 0) rar = g.rarities[Math.max(0, g.rarities.indexOf(rar) - 1)];
      const kind = weightedKey(kindWeights(rar, balance, ctx), rng);
      const c = kind && makeCard(kind, state, team, balance, rng, ctx);
      if (c && passesRules(c, cards, balance)) card = c;
    }
    // 【假设】30 次都失败：给 growth_fallback（attr_s）；仍不合法（全队属性已满且不重复）→ 这一槽空着（少于 4 张）
    if (!card) { const fb = makeCard(g.growth_fallback, state, team, balance, rng, ctx); if (fb && passesRules(fb, cards, balance)) card = fb; }
    if (card) cards.push(card);
  }
  if (!cards.some(c => g.growth_kinds.includes(c.kind))) {
    let i = cards.map(c => c.rarity).lastIndexOf('common');
    if (i < 0) i = cards.length - 1; // 【假设】没有普通卡时换最后一张（实际不会发生：非成长、非普通的卡最多 3 种）
    const fb = makeCard(g.growth_fallback, state, team, balance, rng, ctx)
      ?? makeCard('troops_s', state, team, balance, rng, ctx); // 【假设】属性全满时改给补兵
    if (fb && i >= 0) cards[i] = fb; else if (fb) cards.push(fb);
  }
  // 开发 F2→5（PM 2026-10-23）：ctx.forceGeneral → 这一抽保证有 1 张武将卡（没有时换掉最后一张不是唯一成长卡的卡）。
  // 只有调试菜单会传；不传时不多掷随机数，结果和以前完全一样。
  if (ctx.forceGeneral && !cards.some(c => c.kind.startsWith('general_'))) {
    const gen = makeCard('general_A', state, team, balance, rng, ctx) ?? makeCard('general_S', state, team, balance, rng, ctx);
    const growth = cards.filter(c => g.growth_kinds.includes(c.kind)).length;
    let i = cards.length - 1;
    while (i > 0 && g.growth_kinds.includes(cards[i].kind) && growth <= 1) i--;
    if (gen) { if (cards.length < g.offer_size) cards.push(gen); else cards[i] = gen; }
  }
  const offerN = gachaState(state).n;
  cards.forEach((c, i) => { c.id = `d${offerN}-${ctx.refreshTag ?? 0}-${i}`; });
  return { cards, hadEpic: cards.some(c => c.rarity === 'epic') };
}

export function canOpen(state, team, balance, { inBattle = false } = {}) {
  const gs = gachaState(state), cost = drawCost(gs.n, balance);
  if (gs.offer) return { ok: true, cost, reason: 'resume', text: '上一次的 4 张还没选' };
  if (inBattle) return { ok: false, cost, reason: 'battle', text: '战斗中不能抽卡' };
  if (state.pendingGenerals?.length) return { ok: false, cost, reason: 'pending', text: '有待安排的武将，请先处理' };
  if (state.points < cost) return { ok: false, cost, reason: 'points', text: `点数不足：下一抽需要 ${cost} 点，还差 ${cost - state.points} 点` };
  return { ok: true, cost, reason: null, text: '' };
}

/** 付费并生成 4 张；已有未选完的 offer 时不扣点直接返回它 */
export function openDraw(state, team, balance, rng, ctx = {}) {
  const gs = gachaState(state);
  if (gs.offer) return gs.offer;
  const chk = canOpen(state, team, balance, ctx);
  if (!chk.ok) throw new Error(chk.text);
  state.points -= chk.cost;
  gs.n += 1; state.gachaDraws = gs.n;
  const o = genOffer(state, team, balance, rng, ctx);
  gs.offer = { id: `draw-${gs.n}`, createdAtGameS: ctx.atS ?? null, cost: chk.cost, cards: o.cards, refreshUsed: 0, hadEpic: o.hadEpic };
  return gs.offer;
}

/** 刷新按钮状态：{ok, cost, free, text} */
export function refreshInfo(state, balance, chapter = 0) {
  const g = G6(balance), gs = gachaState(state), o = gs.offer;
  const used = gs.freeRefreshUsed?.[chapter] ?? 0;
  const free = used < g.refresh.free_per_chapter, cost = free ? 0 : g.refresh.cost;
  if (!o) return { ok: false, cost, free, text: '没有可刷新的卡' };
  if (o.refreshUsed >= g.refresh.max_per_draw) return { ok: false, cost, free, text: '这一抽已经刷新过了' };
  if (state.points < cost) return { ok: false, cost, free, text: `刷新要 ${cost} 点` };
  return { ok: true, cost, free, text: free ? '换一批（本章免费）' : `换一批（${cost} 点）` };
}
export function refreshOffer(state, team, balance, rng, ctx = {}) {
  const ch = ctx.chapter ?? 0, info = refreshInfo(state, balance, ch);
  if (!info.ok) throw new Error(info.text);
  const gs = gachaState(state);
  state.points -= info.cost;
  if (info.free) { gs.freeRefreshUsed = [...(gs.freeRefreshUsed ?? [0, 0, 0, 0])]; gs.freeRefreshUsed[ch] = (gs.freeRefreshUsed[ch] ?? 0) + 1; }
  const o = genOffer(state, team, balance, rng, { ...ctx, refreshTag: gs.offer.refreshUsed + 1 });
  gs.offer.cards = o.cards; gs.offer.hadEpic = gs.offer.hadEpic || o.hadEpic; gs.offer.refreshUsed += 1;
  return { cost: info.cost, offer: gs.offer };
}

/** 在一份队伍拷贝上结算卡片（预览用，不动 state） */
function applyToTeam(team, card, balance, extra = {}) {
  const g = G6(balance), c = g.cards[card.kind];
  switch (card.kind) {
    case 'attr_s': case 'attr_b': {
      const gen = team.generals.find(x => x.id === card.target.generalId);
      if (!gen) return null;
      const old = gen[card.target.attr];
      gen[card.target.attr] = Math.min(g.cards.attr_s.cap, old + card.amount);
      return `${gen.name} ${ATTR_NAMES[card.target.attr]} ${old} → ${gen[card.target.attr]}`;
    }
    case 'troops_s': case 'troops_b': {
      const cap = soldierCap(team, balance), old = team.soldiers;
      team.soldiers = Math.min(cap, old + card.amount);
      return `兵 ${old} → ${team.soldiers}（上限 ${cap}）`;
    }
    case 'item': case 'item_counter': {
      const it = balance.items.find(i => i.id === card.target.itemId);
      if (extra.discard != null) team.items[extra.discard] = it.id; else team.items.push(it.id);
      return `获得 ${it.name}：${describeItem(it)}`;
    }
    case 'ep_attr': {
      for (const gen of team.generals) for (const a of c.attrs) gen[a] = Math.min(c.cap, gen[a] + c.amount);
      return `${c.name}：全队 ${c.attrs.map(a => ATTR_NAMES[a]).join('、')} +${c.amount}`;
    }
    case 'ep_troops': {
      team.capBonus = (team.capBonus ?? 0) + c.cap_add;
      if (c.fill) team.soldiers = soldierCap(team, balance);
      return `${c.name}：兵力上限 +${c.cap_add}，兵补满到 ${team.soldiers}`;
    }
    case 'ep_power': team.epPower = +((team.epPower ?? 0) + c.m_add).toFixed(6); return `${c.name}：战力系数 M +${c.m_add}`;
    case 'ep_counter': team.epCounter = +((team.epCounter ?? 0) + c.counter_add).toFixed(6); return `${c.name}：克制倍率 +${c.counter_add}`;
    case 'unit_order': if (extra.unit) changeUnit(team, extra.unit); return extra.unit ? `兵种令：全队改为 ${extra.unit}` : '兵种令';
    case 'drill': team.drill = (team.drill ?? 0) + 1; return `操练：克制倍率 +${card.amount}`;
    default: return '';
  }
}
const cloneTeam = t => ({ ...t, generals: t.generals.map(g => ({ ...g })), items: [...(t.items ?? [])] });

/** 卡面预览：{powerBefore, powerAfter, text, replace?}（武将卡：未满 = 入队后；满 = 每个替换方案） */
export function previewCard(team, card, balance, state) {
  const before = computePower(team, balance);
  if (card.kind.startsWith('general_')) {
    const gen = generalOf(card, balance);
    const pv = pendingPreview(team, gen, balance, computePower);
    if (team.generals.length < balance.team_rules.max_generals) return { powerBefore: before, powerAfter: pv.asDeputy.after, text: '作为副将入队' };
    const best = pv.replace.reduce((a, b) => (b.after > (a?.after ?? -Infinity) ? b : a), null);
    return { powerBefore: before, powerAfter: best?.after ?? before, replace: pv.replace, text: best ? `队伍已满：换下 ${best.name} 后` : '' };
  }
  const t = cloneTeam(team);
  if (card.kind.startsWith('item') && t.items.length >= balance.team_rules.item_slots) {
    return { powerBefore: before, powerAfter: before, text: '物品栏已满：选后丢弃一件（可返回改选）', itemFull: true };
  }
  const text = applyToTeam(t, card, balance);
  return { powerBefore: before, powerAfter: computePower(t, balance), text };
}
export function generalOf(card, balance) {
  const b = balance.generals.find(x => x.id === card.target.generalId);
  return { id: b.id, name: b.name, tier: b.tier, lead: b.lead, str: b.str, int: b.int, cha: b.cha };
}

function finishPick(state, card) {
  const gs = gachaState(state);
  gs.sinceEpic = gs.offer?.hadEpic ? 0 : (gs.sinceEpic ?? 0) + 1;
  gs.offer = null;
}

/**
 * 选第 i 张。opts：{discard: 物品栏下标（物品栏满时）, unit: 兵种（兵种令）, atS}
 * 物品栏满且没给 discard → {next:'item_full'}；兵种令没给 unit → {next:'choose_unit'}；这两种情况 offer 保留（可返回改选别的卡）。
 * 武将卡：移出自由池 → addGeneralOrQueue（满编进 pendingGenerals，由名册弹窗处理，不能返回）。
 */
export function pickCard(state, team, i, balance, rng, opts = {}) {
  const gs = gachaState(state), card = gs.offer?.cards?.[i];
  if (!card) throw new Error('没有这张卡');
  const res = { card, next: null, text: '', powerBefore: computePower(team, balance) };
  if ((card.kind === 'item' || card.kind === 'item_counter') && team.items.length >= balance.team_rules.item_slots && opts.discard == null) {
    return { ...res, next: 'item_full' };
  }
  if (card.kind === 'unit_order' && !opts.unit) return { ...res, next: 'choose_unit' };
  if (card.kind === 'unit_order' && !UNIT_ORDER_UNITS.includes(opts.unit)) throw new Error(`未知兵种 ${opts.unit}`);
  if (card.kind.startsWith('general_')) {
    const gen = generalOf(card, balance);
    state.freePool = state.freePool.filter(x => x !== gen.id);
    const r = addGeneralOrQueue(state, team, gen, { source: 'gacha', from: '抽卡', atS: opts.atS }, balance);
    res.general = gen; res.joined = r.joined;
    res.next = r.joined ? null : 'roster_full';
    res.text = r.joined ? `${gen.name}（${gen.tier}）作为副将加入` : `${gen.name}（${gen.tier}）待安排：队伍已满`;
  } else {
    if (card.kind === 'drill') state.drillUsed = (state.drillUsed ?? 0) + 1;
    if (card.kind.startsWith('item') && opts.discard != null) {
      const old = balance.items.find(x => x.id === team.items[opts.discard]);
      res.discarded = old?.id;
    }
    res.text = applyToTeam(team, card, balance, opts) ?? '';
    if (res.discarded) res.text = `丢弃 ${balance.items.find(x => x.id === res.discarded)?.name}，${res.text}`;
    if (card.kind === 'attr_s' || card.kind === 'attr_b') res.text = res.text || '目标武将已不在队中';
  }
  finishPick(state, card);
  res.powerAfter = computePower(team, balance);
  return res;
}

/** 卡面标题 */
export function cardTitle(card, balance) {
  if (card.name) return card.name;
  if (card.kind === 'attr_s' || card.kind === 'attr_b') return `属性 +${card.amount}`;
  if (card.kind.startsWith('troops')) return `补兵 +${card.amount}`;
  if (card.kind.startsWith('item')) return balance.items.find(i => i.id === card.target.itemId)?.name ?? '物品';
  if (card.kind.startsWith('general_')) return balance.generals.find(g => g.id === card.target.generalId)?.name ?? '武将';
  return KIND_NAMES[card.kind] ?? card.kind;
}
