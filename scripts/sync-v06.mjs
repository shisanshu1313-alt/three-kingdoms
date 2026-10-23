// 从策划正式配置 balance_v0.6.json 生成 src/data/v06.json（抽卡四选一 / 主角统帅 / 名册 / 主城）。
// 用法：npm run sync:v06 [配置路径]（默认 ../design/balance_v0.6.json；CI / 单测用 tests/fixtures/balance_v0.6.json 副本）。
// 正式配置里很多数值写在文字里：这里用正则从原文取数（取不到就报错，策划改了文字会立刻发现），注释标【解读】的是程序对文字的理解。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 纯函数：配置对象 → v06.json 内容（单测直接调用，与生成的文件比对） */
export function buildV06(d) {
  const ca = d.confirmed_assumptions;
  if (!ca || !/定稿/.test(ca.status ?? '')) throw new Error('balance_v0.6.json 缺 confirmed_assumptions（策划定稿）');
  const num = (text, re, what) => { const m = re.exec(text ?? ''); if (!m) throw new Error(`balance_v0.6.json 解析失败（${what}）：${re} 不匹配 "${text}"`); return m.slice(1).map(Number); };
  const one = (text, re, what) => num(text, re, what)[0];
  const G = d.gacha_v06, L = d.leader_v06, R = d.roster_v06, C = d.city_v06;
  const [cb, cs, cc] = num(G.price.formula, /min\(\s*(\d+)\s*\+\s*(\d+)\s*n\s*,\s*(\d+)\s*\)/, 'price.formula');
  const card = k => G.cards[k];
  const troops = k => { const [min, pct] = num(card(k).effect, /max\((\d+),\s*round\((\d+)%/, `cards.${k}`); return { min, pct: pct / 100 }; };
  const OR = G.offer_rules;
  const pseudo = G.flow.pseudocode.join('\n');
  const gacha = {
    cost: { base: cb, step: cs, cap: cc },
    rarities: ['common', 'rare', 'epic'],
    rarity_by_chapter: G.rarity.per_slot_by_chapter,
    pools: G.pools,
    offer_size: one(pseudo, /for slot in 0\.\.(\d+)/, 'pseudocode slot') + 1,
    max_tries: one(pseudo, /repeat up to (\d+)/, 'pseudocode tries'),
    downgrade_every: one(OR.fallback, /连续\s*(\d+)\s*次/, 'offer_rules.fallback'),
    max_same_kind: OR.max_same_kind, max_general_cards: OR.max_general_cards, max_unit_order: OR.max_unit_order,
    growth_kinds: [...new Set([...OR.growth_guarantee.matchAll(/\b(attr_[sb]|troops_[sb]|ep_attr|ep_troops)\b/g)].map(m => m[1]))],
    growth_fallback: 'attr_s',
    troops_illegal_ratio: one(OR.illegal.troops, /上限\s*×\s*(\d+)%/, 'illegal.troops') / 100,
    drill_max: one(OR.illegal.drill, /(\d+)\s*层/, 'illegal.drill'),
    epic_stack_max: one(OR.illegal['ep_power/ep_counter'], /已叠\s*(\d+)\s*次/, 'illegal.ep'),
    cards: {
      attr_s: { rarity: 'common', amount: one(card('attr_s').effect, /\+(\d+)/, 'attr_s'), cap: one(card('attr_s').effect, /上限\s*(\d+)/, 'attr_s cap') },
      attr_b: { rarity: 'rare', amount: one(card('attr_b').effect, /\+(\d+)/, 'attr_b') },
      troops_s: { rarity: 'common', ...troops('troops_s') },
      troops_b: { rarity: 'rare', ...troops('troops_b') },
      item: { rarity: 'common', items: ['war_drum', 'fine_horse', 'supply_cart', 'art_of_war', 'banner', 'scout_flag'] }, // 卡面文字：战鼓 / 良马 / 粮草车 / 兵书 / 招降旗 / 斥候旗
      item_counter: { rarity: 'common', items: ['juma', 'tengjia', 'zhongkai'], threat_mult: one(card('item_counter').effect, /×(\d+)/, 'item_counter ×') },
      unit_order: { rarity: 'common', refund: 0 }, // 选了就算用掉，没有 v0.5 的返还
      drill: { rarity: 'common' },
      general_A: { rarity: 'rare', tier: 'A' },
      general_S: { rarity: 'epic', tier: 'S' },
      ep_attr: { rarity: 'epic', name: card('ep_attr').name, attrs: ['lead', 'str'], amount: one(card('ep_attr').effect, /各\s*\+(\d+)/, 'ep_attr'), cap: one(card('ep_attr').effect, /上限\s*(\d+)/, 'ep_attr cap') },
      ep_troops: { rarity: 'epic', name: card('ep_troops').name, cap_add: one(card('ep_troops').effect, /\+(\d+)/, 'ep_troops'), fill: /补满/.test(card('ep_troops').effect) },
      ep_power: { rarity: 'epic', name: card('ep_power').name, m_add: one(card('ep_power').effect, /\+(0\.\d+)/, 'ep_power') },
      ep_counter: { rarity: 'epic', name: card('ep_counter').name, counter_add: one(card('ep_counter').effect, /\+(0\.\d+)/, 'ep_counter') }
    },
    refresh: {
      free_per_chapter: one(G.refresh.rule, /每章第\s*(\d+)\s*次/, 'refresh free'),
      cost: one(G.refresh.rule, /之后每次\s*(\d+)\s*点/, 'refresh cost'),
      max_per_draw: one(G.refresh.rule, /最多刷新\s*(\d+)\s*次/, 'refresh max')
    },
    counter_kinds: G.chapter_fit.counter_kinds,
    counter_mult_by_chapter: G.chapter_fit.counter_mult_by_chapter,
    threat_mult: G.chapter_fit.threat_mult,
    // 【解读】threat_def「侦察范围内（视野 300 + 侦察 500，斥候旗 +200）」= v0.5 侦察距离 scout_px（含斥候旗加成）
    threat_range: 'scout'
  };
  const lead = {
    sub_lead_k: one(L.player.L, /(\d\.\d+)\s*×\s*Σ副将统率/, 'player.L'),
    speed_L_cap: one(L.applies_to.items.find(i => i.id === 'speed_lead').player, /min\(L,\s*(\d+)\)/, 'speed_lead'),
    sub_affinity_bonus: one(L.applies_to.items.find(i => i.id === 'affinity').player, /M\s*\+\s*(0\.\d+)/, 'affinity player'),
    enemy_affinity_bonus: one(L.applies_to.items.find(i => i.id === 'affinity').enemy, /M\s*\+\s*(0\.\d+)/, 'affinity enemy'),
    hero_growth: { lead: one(L.player.hero_growth, /统率\s*\+(\d+)/, 'growth lead'), str: one(L.player.hero_growth, /武力\s*\+(\d+)/, 'growth str'), cap: one(L.player.hero_growth, /上限\s*(\d+)/, 'growth cap') },
    enemy_score: ['lead', 'str'], // 将才分 = 统率 + 武力；并列取统率高，再并列取数组靠前
    named_armies: [...L.applies_to.enemy_leader.named_army.matchAll(/\b(wei_caocao|shu_guanyu|wu_zhouyu|qun_lvbu)\b/g)].map(m => m[1]).filter((v, i, a) => a.indexOf(v) === i)
  };
  const roster = {
    max_generals: one(R.max_generals, /^(\d+)/, 'roster.max_generals'),
    storage_max: one(R.storage, /最多\s*(\d+)\s*名/, 'roster.storage'),
    swap_radius_px: one(R.storage, /(\d+)\s*px/, 'roster.storage px'),
    exile_points: one(R.new_general_flow.options[2], /返还\s*(\d+)\s*点/, 'exile points')
  };
  const S = C.siege, PC = C.player_city, AI = C.ai;
  const city = {
    radius_px: one(S.shape, /半径\s*(\d+)\s*px/, 'siege.shape r'),
    inside_px: one(S.shape, /≤\s*(\d+)\s*px/, 'siege.shape inside'),
    dmg_k: one(S.damage, /=\s*(0\.\d+)\s*×/, 'siege.damage'),
    unit_siege_mult: S.unit_siege_mult,
    def_by_chapter: S.city_def_by_chapter,
    arrow_power_k: one(S.city_arrows, /射手战力\s*=\s*(0\.\d+)/, 'arrows k'),
    arrow_ref_power: num(S.city_arrows, /（(\d+)\/(\d+)\/(\d+)\/(\d+)）/, 'arrows ref'),
    regen_idle_s: one(S.regen, /(\d+)\s*秒没被攻击/, 'regen idle'),
    regen_pct_per_s: one(S.regen, /每秒回\s*(\d+)%/, 'regen pct') / 100,
    break_window_s: one(S.regen, /(\d+)\s*秒内保持\s*0/, 'break window'),
    // 策划 2026-10-23 city_v06.siege.chapter_change：攻城中换章 → 每秒伤害上限立即按新章（cityTick 每 tick 用当前章上限）；
    // 'keep' = 城防满的（没被打过）抬到新章上限，不满的当前值不变 / 'scale' = 旧版「按比例放大」
    chapter_change: /当前(城防)?值不变|不按新章上限补满/.test(S.chapter_change ?? '') ? 'keep' : /按比例/.test(S.chapter_change ?? '') ? 'scale'
      : (() => { throw new Error(`balance_v0.6.json 解析失败（siege.chapter_change）："${S.chapter_change}"`); })(),
    // 策划 2026-10-23 city_v06.siege.regen_rule：城防归零后，玩家贴着城或正在和守军交战 → 回复倒计时暂停；玩家离开（不贴城且不和守军交战）
    // 累计满 break_window_s 秒才开始回复。'away' = 按玩家离开的时间计；'since_zero'（没有该字段）= 旧规则，从归零那一刻起算
    regen_rule: S.regen_rule ? (one(S.regen_rule, /满\s*(\d+)\s*秒/, 'regen_rule s') === one(S.regen, /(\d+)\s*秒内保持\s*0/, 'break window') ? 'away'
      : (() => { throw new Error('siege.regen_rule 的秒数和 siege.regen 的城破窗口不一致'); })()) : 'since_zero',
    // 策划 2026-10-23 07:22 regen_rule：「倒计时暂停（不重置），再离开时接着计」→ 'pause'（离开时间累计）；只写「暂停」没写不重置 → 'reset'（回来就清零）
    regen_hold: !S.regen_rule ? null : /不重置|接着计|累计/.test(S.regen_rule) ? 'pause' : /暂停/.test(S.regen_rule) ? 'reset'
      : (() => { throw new Error(`balance_v0.6.json 解析失败（siege.regen_rule）："${S.regen_rule}"`); })(),
    capture_hold_s: one(C.main_city.capture, /停\s*(\d+)\s*秒/, 'capture hold'),
    capture_inside_px: one(C.main_city.capture, /(\d+)\s*px/, 'capture px'),
    lost_hold_s: one(PC.lost, /停\s*(\d+)\s*秒/, 'lost hold'),
    lost_def_ratio: one(PC.lost, /城防\s*(\d+)%/, 'lost def') / 100,
    garrison: { city: 'luoyang', faction: 'bandit', power_vs_player: one(C.pace_and_victory.unsimulated_risk, /守军推荐\s*(\d\.\d+)\s*倍/, 'garrison ratio'),
      // 策划 2026-10-23 city_v06.garrison.power_recalc.stronger_hint：标签战力 > 玩家战力（严格大于）才提示「强于你」，相等不提示 → 'gt'
      stronger_hint: /严格大于|相等不提示/.test(C.garrison?.power_recalc?.stronger_hint ?? '') || !C.garrison?.power_recalc?.stronger_hint ? 'gt' : 'gte' },
    capitals: { xuchang: 'wei', chengdu: 'shu', jianye: 'wu', changan: 'qun' },
    named_in_city_chapters: num(AI.named_in_city, /第\s*(\d+)–(\d+)\s*章待在/, 'named_in_city'),
    named_leash_px: one(AI.named_in_city, /(\d+)\s*px/, 'named leash'),
    ai_siege_player: {
      from_chapter: one(AI.ai_siege_player, /从第\s*(\d+)\s*章起/, 'siege from ch'),
      hold_s: one(AI.ai_siege_player, /连续待满\s*(\d+)\s*秒/, 'siege hold'),
      min_ratio: one(AI.ai_siege_player, /≥\s*玩家\s*(\d\.\d+)\s*倍/, 'siege ratio'),
      spawn_dist_px: num(AI.ai_siege_player, /(\d+)–(\d+)\s*px/, 'siege dist'),
      spawn_ratio: num(AI.ai_siege_player, /(\d\.\d+)–(\d\.\d+)\s*倍/, 'siege spawn ratio'),
      cooldown_s: one(AI.ai_siege_player, /每\s*(\d+)\s*秒最多/, 'siege cd')
    },
    ai_siege_empty: {
      from_chapter: one(AI.ai_siege_empty_city, /从第\s*(\d+)\s*章起/, 'empty from'),
      away_px: one(AI.ai_siege_empty_city, /(\d+)\s*px\s*以外/, 'empty px'),
      chance_per_min: one(AI.ai_siege_empty_city, /(\d+)%\s*概率/, 'empty chance') / 100
    },
    // C4：回血 / 补兵 / 整编 = 自己主城 + 无主城（距离沿用 v0.5 city_radius_px）
    service_cities: 'own_or_neutral'
  };
  // 策划 2026-10-23 答复（定稿 JSON 里还没有这些字段）：先读配置，没有就用答复里的默认值，并记在 _defaults 里
  const defaults = [];
  const opt = (path, def) => {
    const v = path.split('.').reduce((o, k) => o?.[k], d);
    if (Array.isArray(def) ? Array.isArray(v) : typeof v === 'number') return v;
    defaults.push(path); return def;
  };
  // 策划 2026-10-23：主城被攻（20 s 派兵 + 第 3 章趁虚攻打）都不派这些势力（按势力名或 id）
  city.raid_exclude = opt('city_v06.raid_exclude', ['黄巾']);
  const battle = {
    // 双方连续 no_contact_end_s 秒没接触、谁也没在追、谁也没在放箭 → 这一场以 'separated' 结束（之后同 apart：pair_cd_s 内不再开打，没有保护）
    no_contact_end_s: opt('battle_v06.no_contact_end_s', 4),
    // 【解读】「在追」= 朝对方的接近速度 ≥ 该比例 × 自己最大速度
    no_contact_chase_frac: opt('battle_v06.no_contact_chase_frac', 0.5)
  };
  // 策划 tuning_r1（2026-10-23 已定）：T1–T4 生效（见下面 on()），T5 / T6 用户否决、不实现。
  // 以后策划把值挪进正式字段（如 city_v06.siege.siege_min_s）时优先读正式字段。
  const TP = Object.fromEntries((d.tuning_r1?.proposals ?? []).map(p => [p.id, p]));
  const str = (text, re, what) => { const m = re.exec(text ?? ''); if (!m) throw new Error(`balance_v0.6.json 解析失败（${what}）：${re} 不匹配 "${text}"`); return m[1]; };
  // tag：decided（已定，直接生效）/ apply_now（决策范围内调参，可直接做）→ 生效；needs_user / rejected（T5 野外收拢、T6 逃脱给点数，用户决定不做）→ 不进配置
  const on = id => ['decided', 'apply_now'].includes(TP[id]?.tag);
  const T2v = TP.T2?.value ?? {}, T4v = TP.T4?.value ?? {};
  const tuning = {
    // T1：每秒城防伤害上限 = 该章城防上限 / siege_min_s（0 = 不限）
    siege_min_s: typeof C.siege?.siege_min_s === 'number' ? C.siege.siege_min_s : on('T1') ? TP.T1.value : 0,
    // T2：场上满 max_ai_teams 时，刷新检查撤下 1 支战力 < stale_ratio × 玩家、不在交战、距玩家 > min_dist_px 的普通黄巾队，腾位重刷
    stale_refresh: { enabled: on('T2'), faction: '黄巾', stale_ratio: T2v.stale_ratio ?? 0.6, min_dist_px: T2v.min_dist_px ?? 400 },
    // T3：按势力（名或 id）覆盖 flee_ratio；其他势力仍按性格
    flee_ratio_by_faction: on('T3') ? { [str(TP.T3.param, /：(\S+?)单独/, 'tuning_r1.T3.param')]: TP.T3.value } : {},
    // T4：洛阳守军战力 = max(garrison_power_floor, city_v06.garrison.power_vs_player × 玩家战力)；正式字段 city_v06.garrison.power_floor 优先
    // recalc：city_v06.garrison.power_recalc 存在 → 'battle_start'（玩家和守军开战那一刻按当时玩家战力重算，交战中不变，remain_frac 累计保留损失；破城防不算开战）；否则 'spawn'（开局算一次）
    garrison_power_floor: typeof C.garrison?.power_floor === 'number'
      ? { enabled: true, value: C.garrison.power_floor, power_vs_player: city.garrison.power_vs_player, recalc: C.garrison.power_recalc ? 'battle_start' : 'spawn',
          // 标签（不在交战）= max(70, 0.5×玩家) × remain_frac（策划 power_recalc.label 已定）；字段缺省 true
          label_applies_ratio: typeof C.garrison.power_recalc?.label_applies_ratio === 'boolean' ? C.garrison.power_recalc.label_applies_ratio : true }
      : TP.T4 ? { enabled: on('T4'), value: T4v.garrison_power_floor, power_vs_player: one(TP.T4.param, /([\d.]+)\s*×\s*玩家战力/, 'tuning_r1.T4.param'), recalc: 'spawn' }
      : { enabled: false, value: 0, recalc: 'spawn' },
    // 策划 tuning_r2 apply_now（N2 / N3）：按章节覆盖黄巾刷新战力区间（× 玩家战力）。键 = 章节下标（0 起）；from 用来核对 run_v05.json 原值
    // N1 是模拟脚本（tools/sim-v06.cjs 追击），不进游戏配置；needs_user（U1 / U2）不实现
    chapter_spawn_power: Object.fromEntries((d.tuning_r2?.apply_now ?? []).filter(a => /spawn_power_vs_player/.test(a.param ?? '')).map(a => {
      const i = one(a.param, /run\.chapters\[(\d+)\]\.spawn_power_vs_player/, `tuning_r2.${a.id}.param`);
      if (!Array.isArray(a.to) || a.to.length !== 2 || !Array.isArray(a.from)) throw new Error(`tuning_r2.${a.id}：from / to 不是 [lo, hi]`);
      return [i, { id: a.id, from: a.from, to: a.to }];
    })),
  };
  return {
    _source: { file: 'balance_v0.6.json', version: d._meta.version, note: '由 scripts/sync-v06.mjs（npm run sync:v06）生成，勿手改' },
    decisions: Object.fromEntries(Object.entries(ca.answers).map(([k, v]) => [k, v.decided])),
    untested: ca.untested,
    gacha, leader: lead, roster, city, battle, tuning,
    _defaults: defaults
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const src = process.argv[2] || new URL('../../design/balance_v0.6.json', import.meta.url);
  const d = JSON.parse(readFileSync(src, 'utf8'));
  writeFileSync(new URL('../src/data/v06.json', import.meta.url), JSON.stringify(buildV06(d), null, 2) + '\n');
  console.log('v06.json <-', d._meta.version);
}
