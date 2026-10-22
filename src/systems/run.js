/**
 * v0.5 一局（roguelike run）的规则（纯函数 / 纯数据，无 Phaser；配置 run_v05.json ← balance_v0.5.json）：
 *   - 章节：按局内时间（20 分钟局 0/4/9/14 分钟）；换章事件
 *   - 开局：first_battle.at_s 刷来袭黄巾（WorldScene 负责落点）；grace_s 内其他 AI 不追玩家
 *   - 失败规则 B：兵力 0 或主角 HP 0；每场结束 HP −= (非胜利 ? 35 × 阵亡/战前 : 0) + (溃逃 ? 20 : 0) + 5 × 撤退失败
 *     脱战（战斗结束 5 s 后）每分钟 +10，城池 200 px 内每秒 +2；兵 < 40 时在城池内每 2 s +1 兵
 *   - 胜利：击败 4 路名将军（玩家有伤害份额）
 *   - 名望 = round(存活分钟 × 2 + 击败名将数 × 50 + 最高战力 / 10)
 * run 是可存档的纯数据；所有函数返回事件列表，表现由 WorldScene / UIScene 处理。
 */
import { chapterIndexAt, counterOf } from './runConfig.js';

export function createRun({ runId, runSeed, hard = false, startUnit = 'inf', cfg }) {
  return {
    runId, runSeed, hard, startUnit,
    chapter: 0, maxChapter: 0, raidDone: false, raidId: null,
    heroHp: cfg.failure.hero_hp_max, lastBattleEndS: -1e9, recruitAcc: 0,
    unitHistory: [{ t: 0, unit: startUnit }],
    namedDefeated: [], maxPower: 0, battlesWon: 0, battles: 0,
    over: null // { result: 'defeat' | 'victory', reason, atS }
  };
}

/** 局内时间 tS 时玩家的兵种（unitHistory 记录换兵种） */
export function unitAt(run, tS) {
  let u = run.unitHistory[0]?.unit ?? 'inf';
  for (const h of run.unitHistory) if (h.t <= tS) u = h.unit;
  return u;
}
export function recordUnit(run, tS, unit) {
  if (unitAt(run, tS) !== unit) run.unitHistory.push({ t: tS, unit });
  if (run.unitHistory.length > 50) run.unitHistory.splice(1, run.unitHistory.length - 50);
}
/** 针对兵种：克制玩家 target_lag_s 秒前兵种的兵种 */
export function targetUnitFor(run, tS, cfg, counters) {
  return counterOf(unitAt(run, Math.max(0, tS - cfg.target_lag_s)), counters);
}

/**
 * 每个固定 tick 调用。p = { soldiers, cap, power, inBattle, inCity }
 * 返回事件：chapter / raid / recruit / fail
 */
export function runTick(run, tS, dt, p, cfg) {
  const ev = [];
  if (run.over) return ev;
  const ch = chapterIndexAt(tS, cfg);
  if (ch !== run.chapter) { run.chapter = ch; run.maxChapter = Math.max(run.maxChapter, ch); ev.push({ type: 'chapter', idx: ch, chapter: cfg.chapters[ch] }); }
  if (!run.raidDone && tS >= cfg.first_battle.at_s) { run.raidDone = true; ev.push({ type: 'raid' }); }
  run.maxPower = Math.max(run.maxPower, p.power);
  const F = cfg.failure;
  if (!p.inBattle && tS - run.lastBattleEndS >= F.no_regen_after_battle_s) {
    const regen = p.inCity ? F.regen_in_city_per_s * dt : F.regen_out_of_battle_per_min / 60 * dt;
    run.heroHp = Math.min(F.hero_hp_max, run.heroHp + regen);
  }
  // 城池征兵（soldier_floor_redesign）
  if (!p.inBattle && p.inCity && p.soldiers < F.recruit_floor && p.soldiers > 0) {
    run.recruitAcc += dt;
    if (run.recruitAcc >= F.recruit_interval_s) { run.recruitAcc -= F.recruit_interval_s; if (p.soldiers < p.cap) ev.push({ type: 'recruit', n: 1 }); }
  } else run.recruitAcc = 0;
  const f = checkFail(run, p.soldiers, tS);
  if (f) ev.push(f);
  return ev;
}

export function checkFail(run, soldiers, tS) {
  if (run.over) return null;
  if (soldiers <= 0 || run.heroHp <= 0) {
    run.over = { result: 'defeat', reason: soldiers <= 0 ? 'soldiers' : 'hero_hp', atS: tS };
    return { type: 'fail', reason: run.over.reason };
  }
  return null;
}

/** 玩家一场战斗结束（melee combat-end）：e = { start, soldiers, lost, routed, endKind, escFails, wiped } → 扣 HP */
export function heroDamage(e, cfg) {
  const F = cfg.failure, win = e.endKind === 'defeat' && !e.wiped;
  const dead = win ? 0 : F.hero_hp_per_dead * (e.lost / Math.max(1, e.start));
  return dead + (e.routed ? F.hero_hp_rout : 0) + F.hero_hp_esc_fail * (e.escFails ?? 0);
}
export function onPlayerBattleEnd(run, e, tS, cfg) {
  const dmg = heroDamage(e, cfg);
  run.heroHp = Math.max(0, run.heroHp - dmg);
  run.lastBattleEndS = tS; run.battles++;
  if (e.endKind === 'defeat' && !e.wiped) run.battlesWon++;
  return dmg;
}

/** 名将军被击败（玩家有伤害份额才算讨伐）→ 4 路全灭 = 胜利 */
export function onNamedDefeated(run, id, playerShare, tS, cfg) {
  if (run.over || !cfg.run_goal.named.includes(id) || !(playerShare > 0) || run.namedDefeated.includes(id)) return null;
  run.namedDefeated.push(id);
  if (cfg.run_goal.named.every(n => run.namedDefeated.includes(n))) {
    run.over = { result: 'victory', reason: 'all_named', atS: tS };
    return { type: 'victory' };
  }
  return { type: 'named', id, left: cfg.run_goal.named.length - run.namedDefeated.length };
}

/** 结算摘要（结算画面 + 局外数据） */
export function runSummary(run, tS, cfg) {
  const fm = cfg.meta.fame;
  const minutes = tS / 60;
  const fame = Math.floor(minutes * fm.per_min + run.namedDefeated.length * fm.per_named + run.maxPower / fm.power_div + 0.5 + 1e-9);
  return {
    runId: run.runId, runSeed: run.runSeed, result: run.over?.result ?? 'abandon', reason: run.over?.reason ?? null,
    survivedS: tS, chapterReached: run.maxChapter + 1, namedDefeated: [...run.namedDefeated], maxPower: Math.round(run.maxPower),
    battles: run.battles, battlesWon: run.battlesWon, fame, hard: run.hard
  };
}
