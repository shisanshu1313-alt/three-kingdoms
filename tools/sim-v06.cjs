// v0.6 无界面 20 分钟确定性模拟（开发工具，不是 npm test 的一部分）。
// 在 headless Chrome 里跑真实游戏逻辑（WorldScene.debugAdvance 固定 tick），用一个简单的脚本玩家：
//   抽卡（选战力最高的卡；队伍满的武将直接流放）→ 走向洛阳攻城占城 → 之后守主城、出城打比自己弱的队、残血回城。
// 可复现：同一种子每次结果完全相同（window.__SANGUO_SIM 固定 runSeed + manualTick，见下）。REPEAT=2 每个种子跑两遍并逐字节比较结果 JSON（不同 → 退出码 1）。
// 用法：PW_PATH=... node tools/sim-v06.cjs [url] ；STRAT=farm（默认）|rush|active（active = 策划 tuning_r1 的主动脚本玩家）；SEEDS=1,2,3 MINUTES=20 OUT=/workspace/v06-sim.json ；STALL_S=6（脚本玩家无接触多少秒后自己走开）；TUNING=off（关掉 tuning_r1 T1–T4 和 tuning_r2 N2/N3、U1 跑基线）；PURSUE=0（关掉 tuning_r2 N1 追击）PURSUE_RATIO=0.9
const { chromium } = require(process.env.PW_PATH || '/workspace/.tools/node_modules/playwright-core');
const URL = process.argv[2] || 'http://localhost:5182/';
const SEEDS = (process.env.SEEDS || '1,2,3').split(',').map(Number);
const MIN = Number(process.env.MINUTES || 20);
const OUT = process.env.OUT || null;
const REPEAT = Math.max(1, Number(process.env.REPEAT || 1));
// TUNING=off：关掉 tuning_r1 的 T1–T4（基线对比）；TUNING='{"siege_min_s":20}' 之类：覆盖 balance.v06.tuning 的键（只在 dev 构建有效）
const TUNING_OVERRIDE = process.env.TUNING === 'off'
  ? JSON.stringify({ siege_min_s: 0, stale_refresh: { enabled: false }, flee_ratio_by_faction: {}, garrison_power_floor: { enabled: false }, chapter_spawn_power: {}, first_battle_at_s: null })
  : (process.env.TUNING ? JSON.stringify(JSON.parse(process.env.TUNING)) : 'null');

// 可复现：固定 runSeed（所有游戏随机数流都从它派生）+ manualTick（实时循环不推进逻辑，只由 debugAdvance 按固定 0.1 s tick 推进）。
// Math.random 也按种子替换（游戏逻辑已不用它，这里只是保险：Phaser 内部等的调用不影响结果）。
const seedScript = seed => `(() => {
  window.__SANGUO_SIM = { seed: ${seed}, manualTick: true, tuning: ${TUNING_OVERRIDE} };
  let a = ${seed} >>> 0; Math.random = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
})();`;

async function botInit(p, SEED) {
  await p.evaluate(async ([STRAT, FARM_SOLD, STALL_S, SEED, PURSUE, PURSUE_RATIO]) => {
    const G = await import('/src/systems/gachaOffer.js'), R = await import('/src/systems/roster.js'), L = await import('/src/systems/leader.js');
    const D = await import('/src/data/index.js'), U = await import('/src/systems/gacha.js'), M = await import('/src/systems/melee.js');
    const bal = D.balance, w = __game.scene.getScene('World'), gs = __game.scene.getScene('Gacha');
    const B = window.__bot = { log: [], samples: [], events: [], seen: new WeakSet(), draws: [], battles: {}, minHpBeforeCap: 100, minSoldBeforeCap: 1e9,
      luoyangCapS: null, luoyangDefZeroS: null, luoyangSiegeStartS: null, garrisonDeadS: null, prompts: 0, strat: STRAT, farmSold: FARM_SOLD, start: { x: w.player.x, y: w.player.y } };
    B.tuning = JSON.parse(JSON.stringify(bal.v06.tuning ?? null)); // 本局实际生效的 tuning（写进结果，便于对比）
    __game.events.on('city-prompt', e => { B.prompts++; w.answerRelocate(e.cityId, false); });
    // v0.6 battle.no_contact_end_s：记玩家参与的 'separated' 结束次数（游戏规则自己解开的僵持）
    B.separated = 0; B.stallS = STALL_S; B.pursue = PURSUE; B.pursueRatio = PURSUE_RATIO; B.pursuits = 0;
    const H = w.field.hooks, onSep = H.onSeparated;
    H.onSeparated = (a, b, e) => { if (a?.isPlayer || b?.isPlayer) B.separated++; return onSep?.(a, b, e); };
    // ===== STRAT=active：移植自策划 /workspace/tuning_r1/sg06/tools/sim-r1.cjs（按策划模拟 sim_v06_gacha.py 的玩家规则：
    //   只打估算比 ≥ 1.1 的队、躲 ≥ 1.0 的、HP<45 或兵<20 回主城、会用兵种令、绕开打不过的名将军领地、不在城里干坐）。
    //   改动：游荡路点用脚本自己的种子流 B.rnd（不用 Math.random），僵持阈值用 STALL_S（同另两种策略），去掉 TRACE2。=====
    { let a = (SEED ^ 0x9e3779b9) >>> 0; B.rnd = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
    const CNT = { cav: 'arc', arc: 'inf', inf: 'spr', spr: 'cav' }, CM = [1.0, 1.1, 1.25, 1.45];
    const PRED = u => Object.keys(CNT).find(k => CNT[k] === u); // 克制 u 的兵种
    const named = new Set(['wei_caocao', 'shu_guanyu', 'wu_zhouyu', 'qun_lvbu']);
    const est = (a, b) => { const ch = w.run.chapter; let m = 1; if (CNT[a.team.unit] === b.team.unit) m *= CM[ch]; if (CNT[b.team.unit] === a.team.unit) m /= CM[ch]; return a.power * m / Math.max(1, b.power); };
    const DIST = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const protectedIn = e => { if (named.has(e.id) && w.aiSystem.holdNamed) return true; const c = e.team.cityHold ? w.state.cities[e.team.cityHold] : null; return !!(c && c.def > 0 && DIST(e, c) <= 70); };
    const nearHostileCity = q => Object.values(w.state.cities).some(c => c.owner !== 'player' && c.id !== 'luoyang' && c.def > 0 && DIST(q, c) < 230);
    B.resolveGen = (st, team) => {
      while (st.pendingGenerals.length) {
        const g = st.pendingGenerals[0].general, idx = R.replaceableIndices(team, bal);
        let wi = -1, wv = g.lead + g.str;
        for (const i of idx) { const x = team.generals[i]; if (x.lead + x.str < wv) { wv = x.lead + x.str; wi = i; } }
        if (wi >= 0) R.resolvePending(st, team, 'replace', wi, bal, { dest: 'exile' }); else R.resolvePending(st, team, 'exile', 0, bal);
      }
    };
    B.threatUnit = () => { const P = pl(); const ens = w.aiParties.filter(e => e.faction !== P.faction && DIST(e, P) < 500 && CNT[e.team.unit] === P.team.unit); return ens.length ? ens[0].team.unit : null; };
    B.bestUnit = () => { // 克制附近最强敌队 / 最弱未讨伐名将军；同时不被附近敌队克制
      const P = pl(), ens = w.aiParties.filter(e => e.faction !== P.faction && DIST(e, P) < 500).sort((a, b) => b.power - a.power);
      const tgt = ens[0] ?? w.aiParties.filter(e => named.has(e.id)).sort((a, b) => a.power - b.power)[0];
      return tgt ? PRED(tgt.team.unit) : P.team.unit;
    };
    B.unitOrderValue = () => { const P = pl(), u = B.bestUnit(); if (u === P.team.unit) return -0.5; const ch = w.run.chapter; return B.threatUnit() || ch >= 2 ? P.power * (CM[ch] - 1) * 0.6 + 1 : -0.5; };
    B.activeStep = (t, P, st, team, cs, lo) => {
      const home = st.homeCity && cs[st.homeCity];
      const body = w.field.body(P.id), sold = body && M.inCombat(body) ? M.soldiersOf(body) : team.soldiers;
      if (!home) { B.minHpBeforeCap = Math.min(B.minHpBeforeCap, w.run.heroHp); B.minSoldBeforeCap = Math.min(B.minSoldBeforeCap, sold); }
      const enemies = w.aiParties.filter(e => e.faction !== P.faction);
      const vis = enemies.filter(e => DIST(e, P) <= 300);
      const needRest = w.run.heroHp < 45 || sold < 20;
      const threats = vis.filter(e => est(e, P) >= 1.0 && !protectedIn(e) && DIST(e, P) < 220);
      const raidOn = !w.run.raidDone || enemies.some(e => e.team.raid);
      const prey = vis.filter(e => est(P, e) >= (raidOn && !e.team.raid ? 1.6 : 1.1) && !protectedIn(e) && !(e.team.cityHold && !(lo.def <= 0)))
        .sort((a, b) => DIST(a, P) - DIST(b, P));
      const gar = enemies.find(e => e.team.cityHold === 'luoyang');
      let goal = null, mode = 'wander';
      const gotoCity = !home && lo.garrison && w.run.raidDone && !enemies.some(e => e.team.raid) && !needRest && gar && est(P, gar) >= 1.3;
      if (gotoCity && B.luoyangSiegeStartS == null && DIST(P, lo) < 140) B.luoyangSiegeStartS = t;
      const sieger = home && enemies.find(e => e.team.siegeTarget === home.id && DIST(e, home) < 400 && est(P, e) >= 1.0);
      if (needRest && home) { mode = 'rest'; goal = home; }
      else if (threats.length) { mode = 'flee'; const o = threats.sort((a, b) => DIST(a, P) - DIST(b, P))[0]; const dx = P.x - o.x, dy = P.y - o.y, n = Math.hypot(dx, dy) || 1; goal = { x: P.x + dx / n * 200, y: P.y + dy / n * 200 }; }
      else if (needRest) { mode = 'rest'; const o = vis.sort((a, b) => DIST(a, P) - DIST(b, P))[0]; if (o && DIST(o, P) < 200) { const dx = P.x - o.x, dy = P.y - o.y, n = Math.hypot(dx, dy) || 1; goal = { x: P.x + dx / n * 200, y: P.y + dy / n * 200 }; mode = 'rest_flee'; } }
      else if (gotoCity || (!home && lo.def <= 0 && !lo.garrison) || (!home && lo.def <= 0 && gar && est(P, gar) >= 1.1)) { mode = 'luoyang'; goal = { x: lo.x, y: lo.y }; }
      else if (sieger) { mode = 'defend'; goal = sieger; }
      else if (prey.length) { mode = 'hunt'; goal = prey[0]; }
      else {
        const mains = enemies.filter(e => named.has(e.id) && !protectedIn(e) && !(w.aiSystem.holdNamed)).filter(e => est(P, e) >= 1.15).sort((a, b) => a.power - b.power);
        if (mains.length) { mode = 'named'; goal = mains[0]; }
        else {
          if (!B.wp || DIST(P, B.wp) < 20 || t - (B.wpT ?? 0) > 25) {
            for (let k = 0; k < 12; k++) {
              const cx = home ? home.x : P.x, cy = home ? home.y : P.y;
              const wp = { x: Math.max(60, Math.min(1540, cx + (B.rnd() * 2 - 1) * 450)), y: Math.max(60, Math.min(1540, cy + (B.rnd() * 2 - 1) * 450)) };
              const bad = nearHostileCity(wp) || enemies.some(e => named.has(e.id) && est(P, e) < 1.15 && DIST(wp, e) < 480);
              B.wp = wp; B.wpT = t; if (!bad) break;
            }
          }
          goal = B.wp;
        }
      }
      const myPairs = Object.values(w.field.state.pairs).filter(q => q.a === P.id || q.b === P.id);
      B.noContactS = P.inBattle && !myPairs.some(q => q.wasContact) ? (B.noContactS ?? 0) + 1 : 0;
      if (B.noContactS > B.stallS) { B.stalls = (B.stalls ?? 0) + (B.noContactS === B.stallS + 1 ? 1 : 0); if (!goal) goal = home ?? B.start; }
      // 策划 tuning_r2 N1（移植自 /workspace/tuning_r2/sg06b/tools/sim-r2.cjs 的 PURSUE 段）：交战中对手在撤退（combatMode = retreat）或已溃，
      // 且我方估算 ≥ PURSUE_RATIO（默认 0.9）倍 → 像真人一样点击追上去。默认开；PURSUE=0 关掉（= 旧脚本）
      if (B.pursue && P.inBattle && mode !== 'flee' && mode !== 'rest_flee') {
        const foe = myPairs.map(q => w.parties.find(x => x.id === (q.a === P.id ? q.b : q.a))).find(o => o && (o.combatMode === 'retreat' || w.field.body(o.id)?.routed) && est(P, o) >= B.pursueRatio);
        if (foe) { w.model.clickMove(P, foe.x, foe.y); P._goal = { x: foe.x, y: foe.y }; B.pursuits++; mode = 'pursue'; }
      }
      if (mode !== 'pursue' && goal && (!P.inBattle || mode === 'flee' || mode === 'rest_flee' || B.noContactS > B.stallS)) {
        if (!P.path || !P._goal || Math.hypot(P._goal.x - goal.x, P._goal.y - goal.y) > 40) { w.model.clickMove(P, goal.x, goal.y); P._goal = { x: goal.x, y: goal.y }; }
      }
      B.mode = mode; B.modeCnt = B.modeCnt ?? {}; B.modeCnt[mode] = (B.modeCnt[mode] ?? 0) + 1;
      if (false) { const ex = enemies.map(e => ({ id: e.id.slice(0, 14), p: Math.round(e.power), u: e.team.unit, d: Math.round(DIST(e, P)), est: +est(P, e).toFixed(2), st: e.ai?.state })); (B.tr = B.tr ?? []).push({ t: Math.round(t), mode, pw: Math.round(P.power), sold: Math.round(sold), ex }); }
      for (const pr of Object.values(w.field.state.pairs)) {
        if (pr.a !== P.id && pr.b !== P.id) continue;
        const oid = pr.a === P.id ? pr.b : pr.a, o = w.parties.find(x => x.id === oid);
        if (o && !B.battles[oid]) B.battles[oid] = { t: Math.round(t), name: o.name, unit: o.team.unit, myUnit: team.unit, oppPower: Math.round(o.power), myPower: Math.round(P.power), siegeTeam: !!o.team.siegeTarget, garrison: !!o.team.cityHold, named: named.has(oid) };
      }
      if (lo.def <= 0 && B.luoyangDefZeroS == null && lo.owner !== 'player') B.luoyangDefZeroS = t;
      if (!lo.garrison && B.garrisonDeadS == null) B.garrisonDeadS = t;
      if (st.homeCity === 'luoyang' && B.luoyangCapS == null) B.luoyangCapS = t;
      if (B.luoyangDefZeroS != null && B.siegeDur == null && B.luoyangSiegeStartS != null) B.siegeDur = B.luoyangDefZeroS - B.luoyangSiegeStartS;
      for (const e of [...st.battleLog].reverse()) if (!B.seen.has(e)) { B.seen.add(e); B.events.push(`[${Math.round(t)}s] ${e.text}`); }
    };
    // 模态窗口不需要：直接关掉（debugAdvance 不受暂停影响）
    const ctx = () => { gs.world = w; return gs.ctx(); };
    const tS = () => w.clock.now / 1000;
    const pl = () => w.player;
    B.step = () => {
      const t = tS(), P = pl(), st = w.state, team = P.team, cs = st.cities, lo = cs.luoyang;
      // 1) 待安排武将：直接流放
      if (B.strat === 'active') B.resolveGen(st, team); else while (st.pendingGenerals.length) R.resolvePending(st, team, 'exile', 0, bal);
      // 2) 抽卡
      for (let k = 0; k < 5 && !P.inBattle; k++) {
        const c = ctx(); if (!G.canOpen(st, team, bal, c).ok) break;
        const o = G.openDraw(st, team, bal, w.rngs.gacha, c);
        let best = -1, bv = -Infinity;
        o.cards.forEach((card, i) => {
          const pv = G.previewCard(team, card, bal, st);
          let v = pv.powerAfter - pv.powerBefore;
          if (pv.itemFull) v = -1;
          if (card.kind === 'unit_order') v = B.strat === 'active' ? B.unitOrderValue() : -0.5;
          if (card.kind.startsWith('general_') && team.generals.length >= bal.team_rules.max_generals) v = bal.v06.roster.exile_points / 10; // 流放拿点
          if (v > bv) { bv = v; best = i; }
        });
        const card = o.cards[best];
        const opts = { atS: t };
        if (card.kind === 'unit_order') opts.unit = B.strat === 'active' ? B.bestUnit() : (U.UNIT_ORDER_UNITS.includes(team.unit) ? team.unit : U.UNIT_ORDER_UNITS[0]);
        if (card.kind.startsWith('item') && team.items.length >= bal.team_rules.item_slots) opts.discard = 0;
        const before = P.power;
        const r = G.pickCard(st, team, best, bal, w.rngs.gacha, opts);
        if (B.strat === 'active') B.resolveGen(st, team); else while (st.pendingGenerals.length) R.resolvePending(st, team, 'exile', 0, bal);
        P.refresh(); w.field?.refresh?.(P);
        B.draws.push({ ch: w.run.chapter + 1, t: Math.round(t), cost: o.cost, kind: card.kind, before: Math.round(before), after: Math.round(P.power) });
      }
      if (B.strat === 'active') return B.activeStep(t, P, st, team, cs, lo);
      // 3) 行动
      const home = st.homeCity && cs[st.homeCity];
      const body = w.field.body(P.id), sold = body && M.inCombat(body) ? M.soldiersOf(body) : team.soldiers, cap = team.cap ?? team.maxSoldiers ?? P.cap;
      if (!home) { B.minHpBeforeCap = Math.min(B.minHpBeforeCap, w.run.heroHp); B.minSoldBeforeCap = Math.min(B.minSoldBeforeCap, sold); }
      const enemies = w.aiParties.filter(e => e.faction !== P.faction);
      const nearest = enemies.reduce((a, e) => { const d = Math.hypot(e.x - P.x, e.y - P.y); return d < a.d ? { e, d } : a; }, { e: null, d: 1e9 });
      const weak = w.run.heroHp < 35 || sold < 15;
      let goal = null, mode;
      if (!home) {
        if (weak && nearest.e && nearest.d < 260 && !P.inBattle) { mode = 'flee'; const dx = P.x - nearest.e.x, dy = P.y - nearest.e.y, n = Math.hypot(dx, dy) || 1; goal = { x: P.x + dx / n * 200, y: P.y + dy / n * 200 }; }
        else if (weak) { mode = 'rest'; goal = null; }
        else {
          // STRAT=rush：直接攻洛阳；farm：先打弱队攒点抽卡，兵 ≥ FARM_SOLD 且来袭已结束再攻
          const prey = enemies.filter(e => !e.team.cityHold && e.power < 0.85 * P.power && Math.hypot(e.x - P.x, e.y - P.y) < 350)
            .sort((a, b) => Math.hypot(a.x - P.x, a.y - P.y) - Math.hypot(b.x - P.x, b.y - P.y))[0];
          const raidOn = !w.run.raidDone || enemies.some(e => e.team.raid);
          const ready = B.strat === 'rush' || (sold >= B.farmSold && w.run.raidDone && !enemies.some(e => e.team.raid));
          if (ready) { mode = 'luoyang'; goal = { x: lo.x, y: lo.y }; if (B.luoyangSiegeStartS == null && Math.hypot(P.x - lo.x, P.y - lo.y) < 140) B.luoyangSiegeStartS = t; }
          else if (prey && !raidOn) { mode = 'farm'; goal = prey; }
          else { mode = 'wait'; goal = B.start; }
        }
      } else {
        const sieger = enemies.find(e => e.team.siegeTarget === home.id && Math.hypot(e.x - home.x, e.y - home.y) < 500);
        const prey = enemies.filter(e => !e.team.cityHold && Math.hypot(e.x - home.x, e.y - home.y) < 450 && e.power < 0.9 * P.power)
          .sort((a, b) => Math.hypot(a.x - P.x, a.y - P.y) - Math.hypot(b.x - P.x, b.y - P.y))[0];
        if (weak || w.run.heroHp < 60) { mode = 'home'; goal = home; }
        else if (sieger) { mode = 'defend'; goal = sieger; }
        else if (prey) { mode = 'hunt'; goal = prey; }
        else { mode = 'home'; goal = home; }
      }
      // 交战中：一直没接触（对方放弃追击后原地停住，pair 不会自己解除）超过 3 s → 照常走开（真人玩家也会走开）
      const myPairs = Object.values(w.field.state.pairs).filter(q => q.a === P.id || q.b === P.id);
      B.noContactS = P.inBattle && !myPairs.some(q => q.wasContact) ? (B.noContactS ?? 0) + 1 : 0;
      // v0.6 起游戏规则在 no_contact_end_s（4 s）解开；脚本玩家等 STALL_S（默认 6 s）还没解开才自己走开 = 残留僵持
      if (B.noContactS === B.stallS + 1) { // 记下没被规则解开的原因（诊断用）
        const S = w.field.state, bs = S.bodies;
        B.stallInfo = B.stallInfo ?? [];
        for (const q of myPairs) { const o = bs[q.a === P.id ? q.b : q.a], me = bs[P.id]; if (!o || !me) continue;
          B.stallInfo.push({ t: Math.round(t), noContactT: q.noContactT, gap: Math.round(Math.hypot(o.x - me.x, o.y - me.y) - (me.r ?? 0) - (o.r ?? 0)), meV: +(me.v ?? 0).toFixed(1), oV: +(o.v ?? 0).toFixed(1), oUnit: o.unit, meShoot: me.shooting ?? null, oShoot: o.shooting ?? null, pairs: myPairs.length }); }
      }
      if (B.noContactS > B.stallS) { B.stalls = (B.stalls ?? 0) + (B.noContactS === B.stallS + 1 ? 1 : 0); if (!goal) goal = home ?? B.start; }
      // 策划 tuning_r2 N1（移植自 /workspace/tuning_r2/sg06b/tools/sim-r2.cjs 的 PURSUE 段）：交战中对手在撤退（combatMode = retreat）或已溃，
      // 且我方估算 ≥ PURSUE_RATIO（默认 0.9）倍 → 像真人一样点击追上去。默认开；PURSUE=0 关掉（= 旧脚本）
      if (B.pursue && P.inBattle && mode !== 'flee') {
        const foe = myPairs.map(q => w.parties.find(x => x.id === (q.a === P.id ? q.b : q.a))).find(o => o && (o.combatMode === 'retreat' || w.field.body(o.id)?.routed) && est(P, o) >= B.pursueRatio);
        if (foe) { w.model.clickMove(P, foe.x, foe.y); P._goal = { x: foe.x, y: foe.y }; B.pursuits++; mode = 'pursue'; }
      }
      if (mode !== 'pursue' && goal && (!P.inBattle || mode === 'flee' || B.noContactS > B.stallS)) {
        if (!P.path || !P._goal || Math.hypot(P._goal.x - goal.x, P._goal.y - goal.y) > 40) { w.model.clickMove(P, goal.x, goal.y); P._goal = { x: goal.x, y: goal.y }; }
      }
      B.mode = mode;
      // 记录对手（战斗中）
      for (const pr of Object.values(w.field.state.pairs)) {
        if (pr.a !== P.id && pr.b !== P.id) continue;
        const oid = pr.a === P.id ? pr.b : pr.a, o = w.parties.find(x => x.id === oid);
        if (o && !B.battles[oid]) B.battles[oid] = { t: Math.round(t), name: o.name, unit: o.team.unit, myUnit: team.unit, oppPower: Math.round(o.power), myPower: Math.round(P.power),
          oppAffinity: L.affinityBonus(o.team, bal), oppLeadMult: +(w.field.body(oid)?.stats?.leadMult ?? 0).toFixed(3), myLeadMult: +(body?.stats?.leadMult ?? 0).toFixed(3), siegeTeam: !!o.team.siegeTarget, garrison: !!o.team.cityHold };
      }
      // 洛阳
      if (lo.def <= 0 && B.luoyangDefZeroS == null && lo.owner !== 'player') B.luoyangDefZeroS = t;
      if (!lo.garrison && B.garrisonDeadS == null) B.garrisonDeadS = t;
      if (st.homeCity === 'luoyang' && B.luoyangCapS == null) B.luoyangCapS = t;
      // 新日志
      for (const e of [...st.battleLog].reverse()) if (!B.seen.has(e)) { B.seen.add(e); B.events.push(`[${Math.round(t)}s] ${e.text}`); }
    };
    B.sample = () => {
      const P = pl(), body = w.field.body(P.id), home = w.state.homeCity && w.state.cities[w.state.homeCity];
      const ens = w.aiParties.filter(e => e.faction !== P.faction);
      const eLead = ens.map(e => w.field.body(e.id)?.stats?.leadMult).filter(Boolean);
      B.samples.push({ t: Math.round(tS()), ch: w.run.chapter + 1, hp: Math.round(w.run.heroHp), sold: Math.round(body && M.inCombat(body) ? M.soldiersOf(body) : P.team.soldiers),
        power: Math.round(P.power), dHome: home ? Math.round(Math.hypot(P.x - home.x, P.y - home.y)) : null, inCity: w.inCity(P), inBattle: !!P.inBattle, path: !!P.path, pts: w.state.points, mode: B.mode, home: w.state.homeCity, homeDef: home ? Math.round(home.def) : null,
        loDef: Math.round(w.state.cities.luoyang.def), vmax: body ? +M.vmaxOf(body, w.field.cfg).toFixed(1) : null, leadMult: body ? +body.stats.leadMult.toFixed(3) : null,
        enemies: ens.length, enemyAffinity: ens.filter(e => L.affinityBonus(e.team, bal) > 0).length, enemyLeadAvg: eLead.length ? +(eLead.reduce((a, b) => a + b, 0) / eLead.length).toFixed(3) : null,
        enemyPowerMax: Math.round(Math.max(0, ...ens.map(e => e.power))) });
    };
  }, [process.env.STRAT || 'farm', Number(process.env.FARM_SOLD || 35), Number(process.env.STALL_S || 6), SEED, process.env.PURSUE !== '0', Number(process.env.PURSUE_RATIO || 0.9)]);
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const reps = [];
  for (let rep = 0; rep < REPEAT; rep++) {
  const all = []; reps.push(all);
  for (const seed of SEEDS) {
    const ctxB = await browser.newContext({ viewport: { width: 960, height: 600 } });
    await ctxB.addInitScript(seedScript(seed));
    const p = await ctxB.newPage();
    const errs = []; p.on('pageerror', e => errs.push(String(e)));
    const logs = []; p.on('console', m => { const s = m.text(); if (/^\[(city|run)\]/.test(s)) logs.push(s); });
    await p.goto(URL); // 每个种子新开 context → localStorage 本来就是空的（不再 clear + reload：第一次加载跑多远取决于实时，日志会混进来）
    // 标题 → Enter 开新一局；manualTick 下 World 创建后实时循环不推进逻辑，等多久都一样
    await p.waitForFunction(() => window.__game?.scene.isActive('Title') || window.__game?.scene.getScene('World')?.player, null, { timeout: 15000 });
    if (await p.evaluate(() => window.__game.scene.isActive('Title'))) await p.keyboard.press('Enter');
    await p.waitForFunction(() => window.__game?.scene.getScene('World')?.player && window.__game.scene.isActive('UI'), null, { timeout: 15000 });
    const t0 = await p.evaluate(() => { __game.loop.sleep(); return __game.scene.getScene('World').clock.now; }); // 停掉渲染循环（省时间）
    if (t0 !== 0) throw new Error(`manualTick 没生效：开局时钟 ${t0}`);
    await botInit(p, seed);
    let over = null, crash = null;
    for (let s = 0; s < MIN * 60 && !over; s += 10) {
      try { over = await p.evaluate(() => {
        const w = __game.scene.getScene('World'), B = window.__bot;
        for (let i = 0; i < 10 && !w.pendingEnd; i++) { B.step(); w.debugAdvance(1); if (Math.round(w.clock.now / 1000) % 60 === 0) B.sample(); }
        return w.pendingEnd ? w.pendingEnd.summary : null;
      }); } catch (e) { // 游戏逻辑抛错：记下来（结果里 crash 字段、汇总里单列），不让整批停掉
        crash = { msg: String(e).split('\n').slice(0, 4).join(' | '), t: await p.evaluate(() => Math.round(__game.scene.getScene('World').clock.now / 1000)) };
        console.log('CRASH seed', seed, JSON.stringify(crash)); break;
      }
    }
    const res = await p.evaluate(() => { const B = window.__bot, w = __game.scene.getScene('World');
      return { endT: Math.round(w.clock.now / 1000), luoyangSiegeStartS: B.luoyangSiegeStartS, luoyangDefZeroS: B.luoyangDefZeroS, garrisonDeadS: B.garrisonDeadS, luoyangCapS: B.luoyangCapS,
        pursuits: B.pursuits, points: w.state.points, run: { namedDefeated: w.run.namedDefeated, battles: w.run.battles, won: w.run.battlesWon },
        minHpBeforeCap: Math.round(B.minHpBeforeCap), minSoldBeforeCap: B.minSoldBeforeCap, draws: B.draws, battles: Object.values(B.battles), samples: B.samples, events: B.events, prompts: B.prompts, stalls: B.stalls ?? 0, separated: B.separated, stallInfo: B.stallInfo ?? [], modeCnt: B.modeCnt ?? null, siegeDur: B.siegeDur ?? null, staleRemoved: w.staleRemoved ?? 0, tuning: B.tuning, home: w.state.homeCity, heroHp: Math.round(w.run.heroHp) }; });
    res.seed = seed; res.over = over; res.crash = crash; res.consoleLogs = logs; res.errors = errs;
    all.push(res);
    const s = res.samples;
    console.log(`seed ${seed}: end ${res.endT}s ${crash ? 'CRASH' : over ? `${over.result}(${over.reason})` : 'alive'} | 洛阳 接近 ${res.luoyangSiegeStartS}s 城防0 ${res.luoyangDefZeroS}s 守军灭 ${res.garrisonDeadS}s 占城 ${res.luoyangCapS}s | 占城前最低 HP ${res.minHpBeforeCap} 兵 ${res.minSoldBeforeCap} | 抽卡 ${res.draws.length} 次 | 交战 ${res.battles.length} 队 | 僵持（脚本走开）${res.stalls} 次 · separated ${res.separated} 次 | 追击 ${res.pursuits} 次 | 撤下过弱队 ${res.staleRemoved} | errors ${errs.length}`);
    for (const x of s) console.log('  ', JSON.stringify(x));
    await ctxB.close();
  }
  }
  const all = reps[0];
  if (OUT) require('fs').writeFileSync(OUT, JSON.stringify(all, null, 1));
  await browser.close();
  if (REPEAT > 1) {
    let bad = 0;
    for (let i = 0; i < SEEDS.length; i++) {
      const a = JSON.stringify(reps[0][i]);
      for (let r = 1; r < REPEAT; r++) if (JSON.stringify(reps[r][i]) !== a) {
        bad++; const b = reps[r][i], x = reps[0][i], keys = Object.keys(x).filter(k => JSON.stringify(x[k]) !== JSON.stringify(b[k]));
        console.log(`DETERMINISM FAIL seed ${SEEDS[i]}: 第 ${r + 1} 遍与第 1 遍不同，字段 ${keys.join(',')}`);
        for (const k of keys.slice(0, 3)) console.log('   ', k, JSON.stringify(x[k]).slice(0, 300), '\n    vs', JSON.stringify(b[k]).slice(0, 300));
      }
    }
    console.log(bad ? `DETERMINISM FAIL (${bad})` : `DETERMINISM OK：${SEEDS.length} 个种子 × ${REPEAT} 遍结果逐字节相同`);
    if (bad) process.exit(1);
  }
})().catch(e => { console.error(e); process.exit(1); });
