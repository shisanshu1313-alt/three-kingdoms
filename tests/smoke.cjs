// 冒烟测试（M2+M3）：node tests/smoke.cjs [url]   需要 playwright-core 与本机 Chrome
// 覆盖：无报错、键盘移动、点击寻路绕障、AI 追击玩家、战斗改变兵力、抽卡（点数不足禁用 / 鼠标抽一次 / 满编替换）、截图
const { chromium } = require(process.env.PW_PATH || 'playwright-core');
const URL = process.argv[2] || 'http://localhost:5173/';
const OUT = __dirname + '/../screenshot.png';

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [], logs = { battleStart: [], battleEnd: [], ai: [], spawn: [] };
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error') errors.push(t);
    if (t.startsWith('[battle-start]')) logs.battleStart.push(t);
    if (t.startsWith('[battle-end]')) logs.battleEnd.push(t.split(' {')[0]);
    if (t.startsWith('[ai]')) logs.ai.push(t);
  });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(URL);
  await page.waitForFunction(() => window.__game?.scene.getScene('World')?.player, null, { timeout: 15000 });
  await page.waitForTimeout(500);
  const W = 'window.__game.scene.getScene("World")';
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const pos = () => ev(() => { const p = window.__game.scene.getScene('World').player; return { x: Math.round(p.x), y: Math.round(p.y) }; });
  // 前半段让玩家无敌，避免被附近黄巾军打断
  await ev(() => { const w = window.__game.scene.getScene('World'); w.player.invincibleUntil = w.time.now + 60000; });
  const result = {};

  // 1) 键盘
  const k0 = await pos();
  await page.keyboard.down('d'); await page.keyboard.down('s'); await page.waitForTimeout(1000);
  await page.keyboard.up('d'); await page.keyboard.up('s');
  const k1 = await pos();
  result.keyboard = { from: k0, to: k1, ok: k1.x !== k0.x || k1.y !== k0.y };

  // 2) 点击寻路绕障：找一处“起点—障碍—终点”水平排列且可达的位置，把玩家放到起点
  const scen = await ev(() => {
    const w = window.__game.scene.getScene('World'), T = w.tileSize, pf = w.pathfinder, g = w.mapData.grid;
    for (let y = 5; y < g.length - 5; y++) for (let x = 5; x < g[0].length - 5; x++) {
      const sx = x - 3, ex = x + 3;
      if (pf.passable(x, y) || !pf.passable(sx, y) || !pf.passable(ex, y)) continue;
      if (!pf.passable(sx, y - 1) || !pf.passable(sx, y + 1) || !pf.passable(sx - 1, y)) continue;
      const path = pf.findPath(sx, y, ex, y);
      if (!path || path.partial || path.length < 9) continue;
      const start = { x: (sx + 0.5) * T, y: (y + 0.5) * T }, end = { x: (ex + 0.5) * T, y: (y + 0.5) * T };
      if (!w.player._fits(start.x, start.y, w) || !w.player._fits(end.x, end.y, w)) continue;
      w.player.clearPath(); w.player.setPosition(start.x, start.y);
      w.cameras.main.centerOn(start.x, start.y);
      return { start, end, wall: { x, y }, tilePathLen: path.length };
    }
    return null;
  });
  if (scen) {
    await page.waitForTimeout(600);
    const screen = await ev(({ end }) => { const c = window.__game.scene.getScene('World').cameras.main; return { x: (end.x - c.worldView.x) * c.zoom, y: (end.y - c.worldView.y) * c.zoom }; }, scen);
    await page.mouse.click(screen.x, screen.y);
    const track = [];
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(250);
      const s = await ev(() => { const w = window.__game.scene.getScene('World'), p = w.player; return { x: p.x, y: p.y, moving: !!p.path, fits: p._fits(p.x, p.y, w) }; });
      track.push(s);
      if (!s.moving && i > 2) break;
    }
    const last = track[track.length - 1];
    const maxDy = Math.max(...track.map(t => Math.abs(t.y - scen.start.y)));
    result.clickAroundObstacle = {
      ...scen, clickedScreen: screen, final: { x: Math.round(last.x), y: Math.round(last.y) },
      distToTarget: Math.round(Math.hypot(last.x - scen.end.x, last.y - scen.end.y)), maxDetourY: Math.round(maxDy),
      alwaysOnPassable: track.every(t => t.fits),
    };
    result.clickAroundObstacle.ok = result.clickAroundObstacle.distToTarget < 12 && maxDy > 16 && result.clickAroundObstacle.alwaysOnPassable;
  } else result.clickAroundObstacle = { ok: false, note: 'no scenario found' };

  // 3) AI 追击：周瑜军（战力≈2.85×玩家，< chase_max_ratio 3；曹操军 4.7× 已不再追）放到玩家 220px 外，解除玩家无敌
  await ev(() => {
    const w = window.__game.scene.getScene('World'), pl = w.player, T = w.tileSize;
    pl.invincibleUntil = 0; pl.clearPath();
    const home = w.findPassableNear(37, 28); pl.setPosition(home.x, home.y); // 回到地图中部开阔处
    // 其他 AI 暂时移开，保证是曹操军来追
    w.aiParties.filter(p => p.id !== 'wu_zhouyu').forEach(p => { if (Math.hypot(p.x - pl.x, p.y - pl.y) < 700) { const f = w.findPassableNear(80, 85); p.setPosition(f.x, f.y); p.clearPath(); } });
    const c = w.aiParties.find(p => p.id === 'wu_zhouyu');
    for (const ang of [0, 1.57, 3.14, 4.71, 0.78, 2.35, 3.92, 5.49]) {
      const x = pl.x + Math.cos(ang) * 220, y = pl.y + Math.sin(ang) * 220;
      const s = w.findPassableNear(Math.floor(x / T), Math.floor(y / T));
      const d = Math.hypot(s.x - pl.x, s.y - pl.y);
      const path = w.pathfinder.findPath(Math.floor(s.x / T), Math.floor(s.y / T), Math.floor(pl.x / T), Math.floor(pl.y / T));
      if (d > 180 && path && !path.partial) { c.setPosition(s.x, s.y); break; }
    }
    c.clearPath(); Object.assign(c.ai, { state: 'wander', targetId: null, ignore: {} });
    w.toggleVision(true);
  });
  const before = await ev(() => { const w = window.__game.scene.getScene('World'); return { player: w.player.soldiers, cao: w.aiParties.find(p => p.id === 'wu_zhouyu')?.soldiers, d: Math.round(Math.hypot(w.player.x - w.aiParties.find(p => p.id === 'wu_zhouyu').x, w.player.y - w.aiParties.find(p => p.id === 'wu_zhouyu').y)) }; });
  let chase = null;
  for (let i = 0; i < 30 && !chase; i++) {
    await page.waitForTimeout(200);
    chase = await ev(() => { const w = window.__game.scene.getScene('World'); const c = w.aiParties.find(p => p.id === 'wu_zhouyu'); return c && c.ai.state === 'chase' && c.ai.targetId === 'player' ? { d: Math.round(Math.hypot(w.player.x - c.x, w.player.y - c.y)), pathLen: c.path?.length ?? 0 } : null; });
  }
  await page.waitForTimeout(700);
  await page.screenshot({ path: __dirname + '/../screenshot-chase.png' });
  // 等战斗结束
  let after = null;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(250);
    after = await ev(() => { const w = window.__game.scene.getScene('World'); return { player: w.player.soldiers, log: w.state.battleLog.map(e => e.text), invincible: w.player.isInvincible(w.time.now), points: w.state.points }; });
    if (after.log.some(t => t.includes('主角军'))) break;
  }
  await page.waitForTimeout(600);
  await page.screenshot({ path: OUT });
  result.chase = { startDist: before.d, observed: chase, ok: !!chase };
  result.battle = { playerSoldiersBefore: before.player, playerSoldiersAfter: after.player, log: after.log, playerInvincibleAfter: after.invincible, points: after.points,
    ok: after.log.some(t => t.includes('主角军')) && after.player !== before.player };
  // 4) M3 抽卡：等所有战斗结束，玩家无敌，避免被打断
  await page.waitForFunction(() => { const w = window.__game.scene.getScene('World'); return !w.player.inBattle && !w.battleSystem.battles?.length; }, null, { timeout: 15000 }).catch(() => {});
  await ev(() => { const w = window.__game.scene.getScene('World'); w.player.invincibleUntil = w.time.now + 600000; w.state.points = 10; });
  const gs = () => ev(() => { const g = window.__game; const ga = g.scene.getScene('Gacha'); const w = g.scene.getScene('World');
    return { gacha: g.scene.isActive('Gacha'), gachaPaused: g.scene.isPaused('Gacha'), roster: g.scene.isActive('Roster'), worldPaused: g.scene.isPaused('World'), ui: ga?.uiState,
      btn: ga?.pullBtn ? { x: ga.pullBtn.x, y: ga.pullBtn.y, enabled: ga.pullBtn.enabled } : null, points: w.state.points, draws: w.state.gachaDraws,
      result: ga?.result ? { type: ga.result.type, text: ga.result.text, next: ga.result.next } : null, gens: w.player.team.generals.map(x => x.id), items: w.player.team.items.slice(),
      freePool: w.state.freePool.slice(), pending: w.state.pendingGenerals.length }; });
  await page.keyboard.press('g'); await page.waitForTimeout(300);
  const poor = await gs();
  await page.keyboard.press('Space'); await page.waitForTimeout(200);
  const poor2 = await gs();
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  const closed = await gs();
  result.gachaInsufficient = { opened: poor.gacha, worldPaused: poor.worldPaused, buttonEnabled: poor.btn?.enabled, pointsAfterTry: poor2.points, closedResumes: !closed.gacha && !closed.worldPaused,
    ok: poor.gacha && poor.worldPaused && poor.btn && !poor.btn.enabled && poor2.points === 10 && poor2.draws === 0 && !closed.gacha && !closed.worldPaused };
  // 调试钩子加点，HUD 按钮（鼠标）打开，鼠标点“抽一次”
  await ev(() => window.__game.scene.getScene('World').debugGrantPoints(990)); // 10 + 990 = 1000
  const hud = await ev(() => { const b = window.__game.scene.getScene('UI').gachaBtn; return { x: b.x + 60, y: b.y + 17 }; });
  await page.mouse.click(hud.x, hud.y); await page.waitForTimeout(300);
  const open = await gs();
  await page.mouse.click(open.btn.x + 120, open.btn.y + 22); await page.waitForTimeout(150);
  const rolling = await gs();
  await page.waitForTimeout(1200);
  let afterPull = await gs();
  if (afterPull.ui === 'CHOOSE_GENERAL') { await page.keyboard.press('1'); await page.waitForTimeout(200); }
  if (afterPull.ui === 'ITEM_FULL') { await page.keyboard.press('0'); await page.waitForTimeout(200); }
  if (afterPull.ui === 'ROSTER_FULL') { await page.keyboard.press('r'); await page.waitForTimeout(300); }
  afterPull = await gs();
  await page.screenshot({ path: __dirname + '/../screenshot-gacha.png' });
  result.gachaPull = { openedByMouse: open.gacha, rollingState: rolling.ui, pointsBefore: open.points, pointsAfter: afterPull.points, draws: afterPull.draws, result: afterPull.result, ui: afterPull.ui,
    ok: open.gacha && rolling.ui === 'ROLLING' && rolling.points === 950 && afterPull.draws === 1 && afterPull.ui === 'RESULT' && !!afterPull.result?.text };
  // 满编替换：队伍补到 3 将，强制下一抽 = S 级武将（诸葛亮），弹出名册窗口，按 1 替换第一名随从
  await ev(() => { const w = window.__game.scene.getScene('World'); const t = w.player.team; const lib = (id) => { const g = window.__balance.generals.find(x => x.id === id); return { id: g.id, name: g.name, tier: g.tier, lead: g.lead, str: g.str, int: g.int, cha: g.cha }; };
    t.generals = t.generals.filter(g => g.id === 'hero');
    t.generals.push(lib('liaohua'), { id: 'smoke_gen', name: '波才', generic: true, lead: 30, str: 40, int: 20, cha: 20 });
    w.state.freePool = w.state.freePool.filter(id => id !== 'liaohua'); w.state.freePool.includes('zhugeliang') || w.state.freePool.push('zhugeliang');
    w.player.refresh();
    window.__realRandom = Math.random; const seq = [0.995, 0]; Math.random = () => (seq.length ? seq.shift() : window.__realRandom()); });
  await page.keyboard.press('Space'); await page.waitForTimeout(1300);
  const rf = await gs();
  await page.screenshot({ path: __dirname + '/../screenshot-roster.png' });
  await page.keyboard.press('1'); await page.waitForTimeout(400);
  const rep = await gs();
  await ev(() => { Math.random = window.__realRandom; });
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  const fin = await gs();
  result.gachaReplace = { rosterOpened: rf.roster, gachaPausedUnderRoster: rf.gachaPaused, uiWhileRoster: rf.ui, gensAfter: rep.gens, liaohuaInFreePool: rep.freePool.includes('liaohua'),
    resultText: rep.result?.text, worldResumed: !fin.worldPaused && !fin.gacha,
    ok: rf.roster && rf.ui === 'ROSTER_FULL' && rep.gens.join() === 'hero,zhugeliang,smoke_gen' && rep.freePool.includes('liaohua') && !rep.roster && rep.ui === 'RESULT' && rep.pending === 0 && !fin.worldPaused && !fin.gacha };
  result.consoleBattles = logs.battleEnd.slice(0, 6);
  result.aiTransitions = logs.ai.slice(0, 8);
  result.errors = errors;
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  const ok = !errors.length && result.keyboard.ok && result.clickAroundObstacle.ok && result.chase.ok && result.battle.ok && result.gachaInsufficient.ok && result.gachaPull.ok && result.gachaReplace.ok;
  console.log(ok ? 'SMOKE OK' : 'SMOKE FAIL');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
