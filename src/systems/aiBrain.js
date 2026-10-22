/**
 * AI 决策（纯函数，无 Phaser；单测见 tests/aiBrain.test.js）
 * 状态：wander（home 附近游荡）/ chase（追击）/ flee（逃跑）/ return（回 home）
 * 参数全部来自 balance.ai：vision_px、personality、chase_give_up_px、chase_max_s、flee_safe_px、flee_max_s、
 *   ignore_target_s、wander_radius_px、return_home_radius_mult；规则见 ratio_rule / valid_target / return_rule。
 */

/**
 * 对单个目标的态度（ai.ratio_rule）：r = 我方面板战力/对方面板战力
 *   r ≤ flee_ratio → flee（优先）；chase_ratio ≤ r < chase_max_ratio → chase；
 *   r ≥ chase_max_ratio → 不追（防碾压，碰上照常开战；chaseMax 不配置则不限）；否则忽略
 */
export function attitude(myPower, enemyPower, personality, chaseMax = Infinity) {
  const { chase_ratio, flee_ratio } = personality;
  const r = myPower / Math.max(1e-9, enemyPower);
  if (r <= flee_ratio) return 'flee';
  if (r >= chase_ratio && r < chaseMax) return 'chase';
  return 'ignore';
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * @param self   { id, faction, power, x, y, home:{x,y} }
 * @param others [{ id, faction, power, x, y, isPlayer, invincible, inBattle }]
 * @param mem    { state, targetId, since, ignore: {id: untilSec} }
 * @param now    当前时间（秒）
 * @param canChase(o) v0.5 追击许可（开局保护、名将坐镇/领地），默认都可以
 * @returns { state, targetId, since, ignore: {id: untilSec} }（新对象，不改入参）
 */
export function decide({ self, others, mem, cfg, personality, now, canChase = () => true }) {
  const ignore = { ...(mem.ignore || {}) };
  for (const k of Object.keys(ignore)) if (ignore[k] <= now) delete ignore[k];
  const set = (state, targetId = null) => ({
    state, targetId, ignore,
    since: state === mem.state && targetId === mem.targetId ? mem.since : now
  });

  // valid_target：不同阵营；不在战斗中；不在 ignore 名单（下方过滤）；玩家战败无敌期不作为目标
  const valid = o => o.id !== self.id && !o.inBattle && o.faction !== self.faction && !(o.isPlayer && o.invincible);
  const visible = others.filter(o => valid(o) && !ignore[o.id] && dist(self, o) <= cfg.vision_px)
    .sort((a, b) => dist(self, a) - dist(self, b));
  const att = o => attitude(self.power, o.power, personality, cfg.chase_max_ratio ?? Infinity);
  const threat = visible.find(o => att(o) === 'flee');
  const prey = visible.find(o => att(o) === 'chase' && canChase(o)); // v0.5：开局 90 s 不追玩家、名将坐镇 / 领地内追
  const homeDist = self.home ? dist(self, self.home) : 0;
  const idle = () => (homeDist > cfg.wander_radius_px * cfg.return_home_radius_mult ? set('return') : set('wander'));

  if (mem.state === 'flee') {
    const t = others.find(o => o.id === mem.targetId);
    const done = !t || dist(self, t) >= cfg.flee_safe_px || now - mem.since >= cfg.flee_max_s;
    if (!done) return set('flee', t.id);
    if (threat && threat.id !== mem.targetId) return set('flee', threat.id);
    return set('return');
  }

  if (threat) return set('flee', threat.id);

  if (mem.state === 'chase') {
    const t = others.find(o => o.id === mem.targetId);
    const lost = !t || !valid(t) || !canChase(t);
    const giveUp = !lost && (dist(self, t) > cfg.chase_give_up_px || now - mem.since >= cfg.chase_max_s);
    if (!lost && !giveUp && att(t) !== 'flee') return set('chase', t.id);
    if (t) ignore[t.id] = now + cfg.ignore_target_s;
    const next = visible.find(o => !ignore[o.id] && att(o) === 'chase' && canChase(o));
    return next ? set('chase', next.id) : idle();
  }

  if (prey) return set('chase', prey.id);
  if (mem.state === 'return' && homeDist > cfg.wander_radius_px) return set('return');
  return idle();
}
