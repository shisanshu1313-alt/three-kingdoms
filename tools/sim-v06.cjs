// v0.6 无界面 20 分钟确定性模拟（开发工具，不是 npm test 的一部分）。
// 在 headless Chrome 里跑真实游戏逻辑（WorldScene.debugAdvance 固定 tick），用一个简单的脚本玩家：
//   抽卡（选战力最高的卡；队伍满的武将直接流放）→ 走向洛阳攻城占城 → 之后守主城、出城打比自己弱的队、残血回城。
// Math.random / crypto 按种子替换 → 同一种子结果可复现。
// 用法：PW_PATH=... node tools/sim-v06.cjs [url] ；SEEDS=1,2,3 MINUTES=20 OUT=/workspace/v06-sim.json
const { chromium } = require(process.env.PW_PATH || '/workspace/.tools/node_modules/playwright-core');
const URL = process.argv[2] || 'http://localhost:5182/';
const SEEDS = (process.env.SEEDS || '1,2,3').split(',').map(Number);
const MIN = Number(process.env.MINUTES || 20);
const OUT = process.env.OUT || null;

const seedScript = seed => `(() => {
  let a = ${seed} >>> 0; const r = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  Math.random = r;
  const g = crypto.getRandomValues.bind(crypto);
  crypto.getRandomValues = arr => { if (arr instanceof Uint32Array) { for (let i = 0; i < arr.length; i++) arr[i] = (r() * 4294967296) >>> 0; return arr; } return g(arr); };
})();`;

async function botInit(p) {
  await p.evaluate(async ([STRAT, FARM_SOLD]) => {
    const G = await import('/src/systems/gachaOffer.js'), R = await import('/src/systems/roster.js'), L = await import('/src/systems/leader.js');
    const D = await import('/src/data/index.js'), U = await import('/src/systems/gacha.js'), M = await import('/src/systems/melee.js');
    const bal = D.balance, w = __game.scene.getScene('World'), gs = __game.scene.getScene('Gacha');
    const B = window.__bot = { log: [], samples: [], events: [], seen: new WeakSet(), draws: [], battles: {}, minHpBeforeCap: 100, minSoldBeforeCap: 1e9,
      luoyangCapS: null, luoyangDefZeroS: null, luoyangSiegeStartS: null, garrisonDeadS: null, prompts: 0, strat: STRAT, farmSold: FARM_SOLD, start: { x: w.player.x, y: w.player.y } };
    __game.events.on('city-prompt', e => { B.prompts++; w.answerRelocate(e.cityId, false); });
    // 模态窗口不需要：直接关掉（debugAdvance 不受暂停影响）
    const ctx = () => { gs.world = w; return gs.ctx(); };
    const tS = () => w.clock.now / 1000;
    const pl = () => w.player;
    B.step = () => {
      const t = tS(), P = pl(), st = w.state, team = P.team, cs = st.cities, lo = cs.luoyang;
      // 1) 待安排武将：直接流放
      while (st.pendingGenerals.length) R.resolvePending(st, team, 'exile', 0, bal);
      // 2) 抽卡
      for (let k = 0; k < 5 && !P.inBattle; k++) {
        const c = ctx(); if (!G.canOpen(st, team, bal, c).ok) break;
        const o = G.openDraw(st, team, bal, w.rngs.gacha, c);
        let best = -1, bv = -Infinity;
        o.cards.forEach((card, i) => {
          const pv = G.previewCard(team, card, bal, st);
          let v = pv.powerAfter - pv.powerBefore;
          if (pv.itemFull) v = -1;
          if (card.kind === 'unit_order') v = -0.5;
          if (card.kind.startsWith('general_') && team.generals.length >= bal.team_rules.max_generals) v = bal.v06.roster.exile_points / 10; // 流放拿点
          if (v > bv) { bv = v; best = i; }
        });
        const card = o.cards[best];
        const opts = { atS: t };
        if (card.kind === 'unit_order') opts.unit = U.UNIT_ORDER_UNITS.includes(team.unit) ? team.unit : U.UNIT_ORDER_UNITS[0];
        if (card.kind.startsWith('item') && team.items.length >= bal.team_rules.item_slots) opts.discard = 0;
        const before = P.power;
        const r = G.pickCard(st, team, best, bal, w.rngs.gacha, opts);
        while (st.pendingGenerals.length) R.resolvePending(st, team, 'exile', 0, bal);
        P.refresh(); w.field?.refresh?.(P);
        B.draws.push({ t: Math.round(t), cost: o.cost, kind: card.kind, before: Math.round(before), after: Math.round(P.power) });
      }
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
      if (B.noContactS > 3) { B.stalls = (B.stalls ?? 0) + (B.noContactS === 4 ? 1 : 0); if (!goal) goal = home ?? B.start; }
      if (goal && (!P.inBattle || mode === 'flee' || B.noContactS > 3)) {
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
  }, [process.env.STRAT || 'farm', Number(process.env.FARM_SOLD || 35)]);
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const all = [];
  for (const seed of SEEDS) {
    const ctxB = await browser.newContext({ viewport: { width: 960, height: 600 } });
    await ctxB.addInitScript(seedScript(seed));
    const p = await ctxB.newPage();
    const errs = []; p.on('pageerror', e => errs.push(String(e)));
    const logs = []; p.on('console', m => { const s = m.text(); if (/^\[(city|run)\]/.test(s)) logs.push(s); });
    await p.goto(URL); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(2000);
    if (await p.evaluate(() => window.__game?.scene.isActive('Title'))) await p.keyboard.press('Enter');
    await p.waitForFunction(() => window.__game?.scene.getScene('World')?.player && window.__game.scene.isActive('UI'), null, { timeout: 15000 });
    await p.evaluate(() => { __game.loop.sleep(); }); // 停掉实时循环：只由 debugAdvance 推进，结果与帧率无关
    await botInit(p);
    let over = null;
    for (let s = 0; s < MIN * 60 && !over; s += 10) {
      over = await p.evaluate(() => {
        const w = __game.scene.getScene('World'), B = window.__bot;
        for (let i = 0; i < 10 && !w.pendingEnd; i++) { B.step(); w.debugAdvance(1); if (Math.round(w.clock.now / 1000) % 60 === 0) B.sample(); }
        return w.pendingEnd ? w.pendingEnd.summary : null;
      });
    }
    const res = await p.evaluate(() => { const B = window.__bot, w = __game.scene.getScene('World');
      return { endT: Math.round(w.clock.now / 1000), luoyangSiegeStartS: B.luoyangSiegeStartS, luoyangDefZeroS: B.luoyangDefZeroS, garrisonDeadS: B.garrisonDeadS, luoyangCapS: B.luoyangCapS,
        minHpBeforeCap: Math.round(B.minHpBeforeCap), minSoldBeforeCap: B.minSoldBeforeCap, draws: B.draws, battles: Object.values(B.battles), samples: B.samples, events: B.events, prompts: B.prompts, stalls: B.stalls ?? 0, home: w.state.homeCity, heroHp: Math.round(w.run.heroHp) }; });
    res.seed = seed; res.over = over; res.consoleLogs = logs; res.errors = errs;
    all.push(res);
    const s = res.samples;
    console.log(`seed ${seed}: end ${res.endT}s ${over ? `${over.result}(${over.reason})` : 'alive'} | 洛阳 接近 ${res.luoyangSiegeStartS}s 城防0 ${res.luoyangDefZeroS}s 守军灭 ${res.garrisonDeadS}s 占城 ${res.luoyangCapS}s | 占城前最低 HP ${res.minHpBeforeCap} 兵 ${res.minSoldBeforeCap} | 抽卡 ${res.draws.length} 次 | 交战 ${res.battles.length} 队 | 僵持解除 ${res.stalls} 次 | errors ${errs.length}`);
    for (const x of s) console.log('  ', JSON.stringify(x));
    await ctxB.close();
  }
  if (OUT) require('fs').writeFileSync(OUT, JSON.stringify(all, null, 1));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
