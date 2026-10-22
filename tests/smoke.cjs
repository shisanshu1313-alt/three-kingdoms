// 冒烟测试（M2）：node tests/smoke.cjs [url]   需要 playwright-core 与本机 Chrome
// 覆盖：无报错、键盘移动、点击寻路绕障、AI 追击玩家、战斗改变兵力、截图
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

  // 3) AI 追击：曹操军（战力≈4.7×玩家）放到玩家 220px 外，解除玩家无敌
  await ev(() => {
    const w = window.__game.scene.getScene('World'), pl = w.player, T = w.tileSize;
    pl.invincibleUntil = 0; pl.clearPath();
    const home = w.findPassableNear(37, 28); pl.setPosition(home.x, home.y); // 回到地图中部开阔处
    // 其他 AI 暂时移开，保证是曹操军来追
    w.aiParties.filter(p => p.id !== 'wei_caocao').forEach(p => { if (Math.hypot(p.x - pl.x, p.y - pl.y) < 700) { const f = w.findPassableNear(80, 85); p.setPosition(f.x, f.y); p.clearPath(); } });
    const c = w.aiParties.find(p => p.id === 'wei_caocao');
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
  const before = await ev(() => { const w = window.__game.scene.getScene('World'); return { player: w.player.soldiers, cao: w.aiParties.find(p => p.id === 'wei_caocao')?.soldiers, d: Math.round(Math.hypot(w.player.x - w.aiParties.find(p => p.id === 'wei_caocao').x, w.player.y - w.aiParties.find(p => p.id === 'wei_caocao').y)) }; });
  let chase = null;
  for (let i = 0; i < 30 && !chase; i++) {
    await page.waitForTimeout(200);
    chase = await ev(() => { const w = window.__game.scene.getScene('World'); const c = w.aiParties.find(p => p.id === 'wei_caocao'); return c && c.ai.state === 'chase' && c.ai.targetId === 'player' ? { d: Math.round(Math.hypot(w.player.x - c.x, w.player.y - c.y)), pathLen: c.path?.length ?? 0 } : null; });
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
  result.consoleBattles = logs.battleEnd.slice(0, 6);
  result.aiTransitions = logs.ai.slice(0, 8);
  result.errors = errors;
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  const ok = !errors.length && result.keyboard.ok && result.clickAroundObstacle.ok && result.chase.ok && result.battle.ok;
  console.log(ok ? 'SMOKE OK' : 'SMOKE FAIL');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
