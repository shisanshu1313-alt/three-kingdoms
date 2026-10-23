// v0.6 浏览器冒烟：抽卡（付费 → 4 张 → 换一批 → 选 1）→ 名册（满编时新武将：替换 + 流放 / 存城）→ 主城（攻洛阳：城防下降 → 消灭守军 → 占城；
// H 主城仓库互换；AI 讨伐军围攻主城 → 城防下降 → 玩家不在 → 失守）。
// 用法：node tests/smoke-v06.cjs [url]（默认 http://localhost:5182/）；截图写到 artifacts/（v06-gacha / v06-city / v06-run.png 写到 SHOTS=目录，默认也是 artifacts/）
const path = require('path');
const { chromium } = require(process.env.PW_PATH || process.env.PW_CORE || '/workspace/.tools/node_modules/playwright-core');
const URL = process.argv[2] || 'http://localhost:5182/';
const OUT = path.join(__dirname, '..', 'artifacts');
const SHOTS = process.env.SHOTS || OUT;
const sleep = (p, ms) => p.waitForTimeout(ms);
(async () => {
  require('fs').mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [], logs = [];
  p.on('pageerror', e => errs.push(String(e)));
  p.on('console', m => { logs.push(m.text()); if (m.type() === 'error') errs.push(m.text()); });
  let n = 0;
  const ok = async (cond, msg) => {
    if (cond) { n++; console.log('ok', n, '-', msg.split('（')[0]); return; }
    console.error('FAIL:', msg); console.error(logs.slice(-25).join('\n'));
    await p.screenshot({ path: path.join(OUT, 'v06-fail.png') }); await b.close(); process.exit(1);
  };
  const W = (fn, arg) => p.evaluate(fn, arg);
  await p.goto(URL); await W(() => localStorage.clear()); await p.reload(); await sleep(p, 2500);
  if (await W(() => window.__game?.scene.isActive('Title'))) { await p.keyboard.press('Enter'); }
  await p.waitForFunction(() => window.__game?.scene.getScene('World')?.player && window.__game.scene.isActive('UI'), null, { timeout: 15000 });
  await sleep(p, 500);
  // 冒烟不测战斗结果：主角无敌、HP 足够，关掉开局遭遇战
  await W(() => { const w = __game.scene.getScene('World'); w.run.raidDone = true; w.run.heroHp = 1e9; w.player.invincibleUntil = w.clock.now + 3600e3; });

  // ---------- 1) 抽卡：付费出 4 张 ----------
  const gs = () => W(() => { const w = __game.scene.getScene('World'), g = __game.scene.getScene('Gacha');
    return { open: __game.scene.isActive('Gacha'), ui: g?.uiState, points: w.state.points, n: w.state.gacha?.n, offer: w.state.gacha?.offer?.cards?.map(c => ({ kind: c.kind, rarity: c.rarity, target: c.target ?? null })) ?? null,
      result: g?.result ? { kind: g.result.card?.kind, text: g.result.text, before: g.result.powerBefore, after: g.result.powerAfter } : null, gens: w.player.team.generals.map(x => x.id) }; });
  const B6 = await W(() => { const g = window.__balance.v06.gacha; return { base: g.cost.base, step: g.cost.step, size: g.offer_size, refreshCost: g.refresh.cost, rarities: g.rarities }; });
  await W(() => { __game.scene.getScene('World').state.points = 1000; });
  await p.keyboard.press('g'); await sleep(p, 300);
  const idle = await gs();
  await ok(idle.open && idle.ui === 'IDLE' && !idle.offer, `G 打开抽卡（${JSON.stringify(idle)}）`);
  await p.keyboard.press('Space'); await sleep(p, 400);
  const o1 = await gs();
  await ok(o1.ui === 'OFFER' && o1.offer.length === B6.size && o1.points === 1000 - B6.base && o1.n === 1 && o1.offer.every(c => B6.rarities.includes(c.rarity)),
    `付费 ${B6.base} 点出 ${B6.size} 张卡（${JSON.stringify(o1)}）`);
  const cardTexts = await W(() => __game.scene.getScene('Gacha').dyn.list.filter(o => o.type === 'Text').map(o => o.text).join(' | '));
  await ok(/战力/.test(cardTexts) && /\[1\]/.test(cardTexts) && /\[4\]/.test(cardTexts), `卡面标出编号和战力变化（${cardTexts.slice(0, 300)}）`);
  await p.screenshot({ path: path.join(SHOTS, 'v06-gacha.png') });
  // 换一批：本章第 1 次免费；同一抽只能换 1 次
  await p.keyboard.press('f'); await sleep(p, 300);
  const o2 = await gs();
  await ok(o2.ui === 'OFFER' && o2.points === o1.points && o2.offer.length === B6.size, `F 换一批（本章免费）（${JSON.stringify({ before: o1.offer.map(c => c.kind), after: o2.offer.map(c => c.kind), pts: o2.points })}）`);
  await p.keyboard.press('f'); await sleep(p, 200);
  const o3 = await gs();
  await ok(JSON.stringify(o3.offer) === JSON.stringify(o2.offer) && o3.points === o2.points, '同一抽第 2 次换一批无效（max_per_draw）');
  // Esc 不能丢掉 4 张；关掉再开回到同一组
  await p.keyboard.press('Escape'); await sleep(p, 200);
  const o4 = await gs();
  await ok(o4.open && o4.ui === 'OFFER', '有 4 张没选时 Esc 不关闭（必须选一张）');
  // 选一张不需要二级选择的卡
  const k = Math.max(0, o4.offer.findIndex(c => !c.kind.startsWith('item') && c.kind !== 'unit_order' && !c.kind.startsWith('general_'))) + 1;
  await p.keyboard.press(String(k)); await sleep(p, 300);
  let r1 = await gs();
  if (r1.ui === 'ITEM_FULL' || r1.ui === 'CHOOSE_UNIT') { await p.keyboard.press('1'); await sleep(p, 300); r1 = await gs(); }
  if (r1.ui === 'ROSTER_FULL') { await p.keyboard.press('r'); await sleep(p, 300); r1 = await gs(); }
  await ok(r1.ui === 'RESULT' && !r1.offer && !!r1.result?.text && typeof r1.result.after === 'number', `选第 ${k} 张 → 结果（${JSON.stringify(r1.result)}）`);
  // 第 2 抽价格上涨
  await p.keyboard.press('Space'); await sleep(p, 300);
  const o5 = await gs();
  await ok(o5.ui === 'OFFER' && o5.points === r1.points - Math.min(B6.base + B6.step, 1e9) && o5.n === 2, `第 2 抽 ${B6.base + B6.step} 点（${o5.points}）`);

  // ---------- 2) 名册：满编时抽到武将 → E 替换 → 1 → R 流放（+exile_points）----------
  const ex = await W(() => window.__balance.v06.roster.exile_points);
  await W(() => { const w = __game.scene.getScene('World'), t = w.player.team, lib = id => { const g = window.__balance.generals.find(x => x.id === id); return { id: g.id, name: g.name, tier: g.tier, lead: g.lead, str: g.str, int: g.int, cha: g.cha }; };
    t.generals = t.generals.filter(g => g.id === 'hero'); t.generals.push(lib('liaohua'), { id: 'smoke_gen', name: '波才', generic: true, lead: 30, str: 40, int: 20, cha: 20 });
    w.state.freePool = w.state.freePool.filter(id => id !== 'liaohua' && id !== 'zhugeliang');
    w.state.gacha.offer.cards[0] = { id: 'smoke-zgl', kind: 'general_S', rarity: window.__balance.v06.gacha.cards.general_S.rarity, target: { generalId: 'zhugeliang' } };
    w.player.refresh(); __game.scene.getScene('Gacha').render(); });
  const pts0 = await W(() => __game.scene.getScene('World').state.points);
  await p.keyboard.press('1'); await sleep(p, 400);
  const rs = await W(() => ({ roster: __game.scene.isActive('Roster'), pend: __game.scene.getScene('World').state.pendingGenerals.length }));
  await ok(rs.roster && rs.pend === 1, `选武将卡、队伍已满 → 名册弹窗（${JSON.stringify(rs)}）`);
  await p.keyboard.press('e'); await sleep(p, 200); await p.keyboard.press('1'); await sleep(p, 200);
  const dest = await W(() => __game.scene.getScene('Roster').flow);
  await p.keyboard.press('r'); await sleep(p, 400);
  const rr = await W(() => { const w = __game.scene.getScene('World'); return { roster: __game.scene.isActive('Roster'), gens: w.player.team.generals.map(g => g.id), points: w.state.points, pend: w.state.pendingGenerals.length, ui: __game.scene.getScene('Gacha').uiState }; });
  await ok(!rr.roster && rr.pend === 0 && rr.gens.join() === 'hero,zhugeliang,smoke_gen' && rr.points === pts0 + ex && rr.ui === 'RESULT',
    `E → 1（换下廖化）→ R 流放：诸葛亮入队，+${ex} 点（${JSON.stringify({ dest, rr })}）`);
  await p.keyboard.press('Escape'); await sleep(p, 300);
  await ok(!(await W(() => __game.scene.isActive('Gacha') || __game.scene.isPaused('World'))), '关闭抽卡，世界继续');

  // ---------- 3) 主城：攻洛阳 ----------
  const C = await W(() => window.__balance.v06.city);
  const ci = () => W(() => { const w = __game.scene.getScene('World'), L = w.state.cities.luoyang;
    return { t: +(w.clock.now / 1000).toFixed(1), def: Math.round(L.def), owner: L.owner ?? null, garrison: !!L.garrison, home: w.state.homeCity, sold: w.player.team.soldiers, inB: !!w.player.inBattle,
      gar: w.aiParties.filter(x => x.team.cityHold).length, store: (w.state.cityStore ?? []).map(g => g.id), ch: w.run.chapter }; });
  const c0 = await ci();
  await ok(c0.def === C.def_by_chapter[0] && c0.garrison && c0.gar === 1 && !c0.owner && !c0.home, `开局洛阳：城防 ${C.def_by_chapter[0]}、有守军（${JSON.stringify(c0)}）`);
  // T4：守军战力 = max(70, 0.5 × 玩家)，城名标签显示守军战力；玩家更弱 → 红色 +「强于你」（标签在城圈下方，不挡城）
  const gl = await W(() => { const w = __game.scene.getScene('World'), L = w.state.cities.luoyang, g = w.aiParties.find(x => x.team.cityHold === 'luoyang'), t = w.cityTexts.luoyang;
    return { gp: Math.round(g.power), pp: w.player.power, text: t.text, color: t.style.color, font: parseInt(t.style.fontSize), visible: t.visible && t.alpha > 0, top: t.y - t.displayHeight * t.originY, below: L.y + window.__balance.v06.city.radius_px }; });
  await ok(gl.gp >= 70 && gl.text.includes(`守军战力 ${gl.gp}`) && gl.visible && gl.font >= 12 && gl.top >= gl.below
    && (gl.pp < gl.gp ? gl.text.includes('强于你') && gl.color === '#ff7777' : !gl.text.includes('强于你')), `洛阳标签显示守军战力（${JSON.stringify(gl)}）`);
  await p.evaluate(() => { const w = __game.scene.getScene('World'), L = w.state.cities.luoyang; w.cameras.main.centerOn(L.x, L.y); });
  await sleep(p, 200); await p.screenshot({ path: path.join(OUT, 'v06-garrison-label.png') });
  // 站在城墙外（城心 + radius + 一点）攻城
  await W(() => { const w = __game.scene.getScene('World'), L = w.state.cities.luoyang; w.player.invincibleUntil = 0; /* 无敌的队伍不开战：攻城这段要真打 */ w.field.teleport(w.player, L.x, L.y + 62); w.player.team.soldiers = 170; w.player.refresh(); w.field.refresh(w.player); });
  await W(() => __game.scene.getScene('World').debugAdvance(2));
  const c1 = await ci();
  await ok(c1.def < c0.def && c1.sold >= 160, `攻城 2 s：城防 ${c0.def} → ${c1.def}，箭塔只损少量兵（${c1.sold}）`);
  await p.screenshot({ path: path.join(SHOTS, 'v06-city.png') });
  for (let i = 0; i < 12 && (await ci()).def > 0; i++) await W(() => __game.scene.getScene('World').debugAdvance(3));
  const c2 = await ci();
  await ok(c2.def === 0, `城防打到 0（t=${c2.t}）`);
  // 进城打守军 → 消灭后坚守 capture_hold_s → 占城为主城
  await W(() => { const w = __game.scene.getScene('World'), L = w.state.cities.luoyang; w.player.setPath([{ x: L.x, y: L.y }]); });
  let c3 = await ci();
  for (let i = 0; i < 20 && c3.home !== 'luoyang'; i++) {
    await W(() => { const w = __game.scene.getScene('World'), L = w.state.cities.luoyang; if (!w.player.inBattle && Math.hypot(w.player.x - L.x, w.player.y - L.y) > 30) w.player.setPath([{ x: L.x, y: L.y }]); w.debugAdvance(2); });
    c3 = await ci();
  }
  await ok(c3.home === 'luoyang' && c3.owner === 'player' && c3.gar === 0, `消灭守军、坚守 ${C.capture_hold_s} s → 洛阳成为主城（${JSON.stringify(c3)}）`);
  const toast = logs.some(l => /洛阳/.test(l) && /主城|占/.test(l));
  // 城防在 break_window_s 之后回复
  await W(s => __game.scene.getScene('World').debugAdvance(s), C.break_window_s + 5);
  const c4 = await ci();
  await ok(c4.def > 0, `城破 ${C.break_window_s} s 后城防开始回复（${c4.def}）`);
  // 在主城里受保护：敌军贴身也不开战
  const prot = await W(() => { const w = __game.scene.getScene('World'), L = w.state.cities.luoyang; w.field.teleport(w.player, L.x, L.y);
    const e = w.aiParties.find(a => a.faction === 'bandit' && !a.team.cityHold && !a.team.siegeTarget) ?? w.aiParties.find(a => !a.team.siegeTarget); if (!e) return null;
    w.field.teleport(e, L.x + 25, L.y); w.debugAdvance(1.5); return { inB: !!w.player.inBattle, pairs: Object.keys(w.field.state.pairs).filter(k => k.includes(w.player.id)).length }; });
  await ok(prot && !prot.inB && prot.pairs === 0, `主城城防 > 0：城内玩家不被敌军开战（${JSON.stringify(prot)}）`);
  await sleep(p, 300); await p.screenshot({ path: path.join(SHOTS, 'v06-run.png') }); // 一局中：洛阳已是主城

  // ---------- 4) 名册存城 + H 主城仓库互换 ----------
  await W(() => { const w = __game.scene.getScene('World'), g = window.__balance.generals.find(x => x.id === 'zhaoyun');
    w.state.freePool = w.state.freePool.filter(id => id !== 'zhaoyun'); w.state.pendingGenerals.push({ general: { id: g.id, name: g.name, tier: g.tier, lead: g.lead, str: g.str, int: g.int, cha: g.cha }, source: 'smoke', from: '冒烟', createdAtGameS: null });
    __game.scene.getScene('UI').openRoster(); });
  await p.waitForFunction(() => __game.scene.isActive('Roster'), null, { timeout: 3000 }).catch(() => {});
  const rOpen = await W(() => __game.scene.isActive('Roster'));
  await p.keyboard.press('e'); await sleep(p, 200); await p.keyboard.press('2'); await sleep(p, 200); await p.keyboard.press('h'); await sleep(p, 400);
  const scAfter = await W(() => __game.scene.getScenes(true).map(x => x.scene.key));
  const st1 = await ci();
  const gens1 = await W(() => __game.scene.getScene('World').player.team.generals.map(g => g.id));
  await ok(rOpen && st1.store.length === 1 && gens1.includes('zhaoyun') && !scAfter.includes('Gacha') && !scAfter.includes('Roster'), `名册：E → 2 → H 换下的武将存进主城，名册关闭后不会拉起抽卡窗口（${JSON.stringify({ rOpen, store: st1.store, gens1, scAfter })}）`);
  for (let i = 0; i < 3 && await W(() => __game.scene.isActive('Roster')); i++) { await p.keyboard.press('Escape'); await sleep(p, 200); }
  await sleep(p, 300);
  await p.keyboard.press('h'); await sleep(p, 400);
  const cityOpen = await W(() => __game.scene.isActive('City'));
  await p.keyboard.press('1'); await sleep(p, 150); await p.keyboard.press('3'); await sleep(p, 150); await p.keyboard.press('Enter'); await sleep(p, 300);
  const gens2 = await W(() => __game.scene.getScene('World').player.team.generals.map(g => g.id));
  const st2 = await ci();
  await ok(cityOpen && st2.store.length === 1 && st2.store[0] !== st1.store[0] && gens2.includes(st1.store[0]), `H 主城仓库：1 + 3 + Enter 互换（${JSON.stringify({ cityOpen, before: [gens1, st1.store], after: [gens2, st2.store] })}）`);
  await p.keyboard.press('Escape'); await sleep(p, 300);
  await ok(!(await W(() => __game.scene.isActive('City') || __game.scene.isPaused('World'))), 'Esc 关闭主城面板，世界继续');

  // ---------- 5) AI 讨伐军围攻主城（第 2 章起；玩家在城里坚守 hold_s 后派出）→ 玩家不在 → 失守 ----------
  await W(() => { const w = __game.scene.getScene('World'), L = w.state.cities.luoyang; for (let i = 0; i < 600 && w.run.chapter < 1; i++) { w.field.teleport(w.player, L.x, L.y); w.debugAdvance(1); } w.field.teleport(w.player, L.x, L.y); L.def = window.__balance.v06.city.def_by_chapter[1]; });
  const c5 = await ci();
  let sieg = null;
  for (let i = 0; i < 20 && !sieg; i++) {
    sieg = await W(() => { const w = __game.scene.getScene('World'), L = w.state.cities.luoyang; w.field.teleport(w.player, L.x, L.y); w.debugAdvance(2);
      const s = w.aiParties.find(x => x.team.siegeTarget === 'luoyang'); return s ? { name: s.name, power: Math.round(s.power), pp: Math.round(w.player.power), t: w.clock.now / 1000 } : null; });
  }
  await ok(c5.ch >= 1 && sieg && sieg.power >= C.ai_siege_player.min_ratio * sieg.pp * 0.99, `第 2 章坚守主城 ${C.ai_siege_player.hold_s} s → 派出讨伐军（${JSON.stringify({ ch: c5.ch, sieg })}）`);
  // 玩家离开主城（远处、无敌），讨伐军到城下攻城
  await W(() => { const w = __game.scene.getScene('World'), L = w.state.cities.luoyang; w.field.teleport(w.player, L.x, L.y + 700); w.player.invincibleUntil = w.clock.now + 3600e3; });
  const d0 = (await ci()).def;
  let c6 = await ci();
  for (let i = 0; i < 40 && c6.home; i++) { await W(() => { const w = __game.scene.getScene('World'), L = w.state.cities.luoyang; w.field.teleport(w.player, L.x, L.y + 700); w.debugAdvance(2); }); c6 = await ci(); if (i === 6) await p.screenshot({ path: path.join(OUT, 'v06-siege.png') }); }
  const lostLog = logs.filter(l => /失守/.test(l)).slice(-1)[0] ?? '';
  await ok(!c6.home && c6.owner !== 'player' && c6.store.length === 0 && c6.def <= Math.ceil(d0 * C.lost_def_ratio) + 50,
    `讨伐军攻破、占城 ${C.lost_hold_s} s → 主城失守，仓库武将丢失（${JSON.stringify({ d0, c6, lostLog: lostLog.slice(0, 120) })}）`);
  await p.screenshot({ path: path.join(OUT, 'v06-lost.png') });

  // ---------- 6) 存档：读档后城池状态一致 ----------
  const before = await W(() => { const w = __game.scene.getScene('World'); w.trySaveNow('manual'); return JSON.stringify(Object.values(w.state.cities).map(c => [c.id, c.owner ?? null, Math.round(c.def)])); });
  await p.reload(); await p.waitForFunction(() => window.__game?.scene.isActive('Title'), null, { timeout: 15000 }); await sleep(p, 300);
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => window.__game.scene.getScene('World')?.player && window.__game.scene.isActive('UI'), null, { timeout: 15000 });
  const after = await W(() => { const w = __game.scene.getScene('World'); const sv = JSON.parse(localStorage.getItem('sanguo-run-v1')); return { v: sv.saveVersion, ai: Number.isInteger(sv.rng?.ai) && w.aiSystem.rng === w.rngs.ai, cities: JSON.stringify(Object.values(w.state.cities).map(c => [c.id, c.owner ?? null, Math.round(c.def)])) }; });
  await ok(after.v === 6 && after.ai && after.cities === before, `存档 v6（含 AI 随机数流，读档后 AI 用种子流），读档后城池（归属 / 城防）一致（${after.cities}）`);

  const bad = errs.filter(e => !/favicon|DevTools/.test(e));
  await ok(bad.length === 0, `无页面错误${bad.length ? '：' + bad.join(' | ') : ''}`);
  console.log(`SMOKE v0.6 OK (${n} checks)`);
  await b.close();
})().catch(e => { console.error(e); process.exit(2); });
