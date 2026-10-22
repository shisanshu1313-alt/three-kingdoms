// 冒烟测试（M2+M3+存档）：node tests/smoke.cjs [url]   需要 playwright-core 与本机 Chrome
// 覆盖：无报错、键盘移动、点击寻路绕障、AI 追击玩家、战斗改变兵力、抽卡（点数不足禁用 / 鼠标抽一次 / 满编替换）、截图
const { chromium } = require(process.env.PW_PATH || 'playwright-core');
const URL = process.argv[2] || 'http://localhost:5173/';
const ART = require('path').join(__dirname, '..', 'artifacts'); // 截图输出目录（.gitignore，不进仓库）
require('fs').mkdirSync(ART, { recursive: true });
const OUT = ART + '/screenshot.png';

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [], logs = { battleStart: [], battleEnd: [], ai: [], spawn: [], saves: [] };
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error') errors.push(t);
    if (t.startsWith('[battle-start]')) logs.battleStart.push(t);
    if (t.startsWith('[battle-end]')) logs.battleEnd.push(t.split(' {')[0]);
    if (t.startsWith('[ai]')) logs.ai.push(t);
    if (t.startsWith('[save]')) logs.saves.push(t.split(' ')[1]);
  });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(URL);
  await page.waitForFunction(() => window.__game?.scene.getScene('World')?.player, null, { timeout: 15000 });
  await page.waitForTimeout(500);
  const W = 'window.__game.scene.getScene("World")';
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const pos = () => ev(() => { const p = window.__game.scene.getScene('World').player; return { x: Math.round(p.x), y: Math.round(p.y) }; });
  // 前半段让玩家无敌，避免被附近黄巾军打断
  await ev(() => { const w = window.__game.scene.getScene('World'); w.player.invincibleUntil = w.clock.now + 60000; });
  // 这是 v0.4 玩法的回归冒烟：关掉 v0.5 一局的开局遭遇战（20 s）和新手保护（90 s 不追玩家），否则追击 / 点击寻路场景会被打断。
  // v0.5 一局的流程由 tests/smoke-run.cjs 覆盖。
  await ev(() => { const w = window.__game.scene.getScene('World'); w.run.raidDone = true; w.aiSystem.rules.graceUntilS = 0; });
  const result = {};

  // 1) 键盘
  const k0 = await pos();
  await page.keyboard.down('d'); await page.keyboard.down('s'); await page.waitForTimeout(1000);
  await page.keyboard.up('d'); await page.keyboard.up('s');
  const k1 = await pos();
  result.keyboard = { from: k0, to: k1, ok: k1.x !== k0.x || k1.y !== k0.y };

  // 1b) 输入动作层：方向键移动、F1 切换调试视野（按住不重复切换）、滚轮缩放
  {
    const a0 = await pos();
    // v0.5：有转向速率（turn_dps）和加速度，先前朝右下，掉头要时间 → 按 1.2 s
    await page.keyboard.down('ArrowLeft'); await page.waitForTimeout(1200); await page.keyboard.up('ArrowLeft');
    const a1 = await pos();
    const vis = () => ev(() => window.__game.scene.getScene('World').debugVision);
    const v0 = await vis();
    // Phaser 的键盘事件在下一次游戏循环里处理：按完稍等再读状态
    await page.keyboard.press('F1'); await page.waitForTimeout(150); const v1 = await vis();
    await page.keyboard.down('F1'); await page.keyboard.down('F1', { repeat: true }); await page.keyboard.down('F1', { repeat: true }); await page.keyboard.up('F1');
    await page.waitForTimeout(150);
    const v2 = await vis();
    const zoom = () => ev(() => window.__game.scene.getScene('World').cameras.main.zoom);
    const z0 = await zoom();
    await page.mouse.move(300, 300); await page.mouse.wheel(0, 100); await page.waitForTimeout(200);
    const z1 = await zoom();
    await page.mouse.wheel(0, -100); await page.waitForTimeout(200);
    const z2 = await zoom();
    result.inputActions = { arrow: { from: a0, to: a1 }, vision: [v0, v1, v2], zoom: [z0, z1, z2], ok: a1.x < a0.x && v1 === !v0 && v2 === v0 && z1 < z0 && z2 === z0 };
  }

  // 2) 点击寻路绕障：找一处“起点—障碍—终点”水平排列且可达的位置，把玩家放到起点
  const scen = await ev(() => {
    const w = window.__game.scene.getScene('World'), T = w.tileSize, pf = w.pathfinder, g = w.mapData.grid;
    for (let y = 8; y < g.length - 5; y++) for (let x = 5; x < g[0].length - 5; x++) { // y ≥ 8：v0.5 小地图上避开右上角小地图区域
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
    w.aiSystem.rules.namedIds.delete('wu_zhouyu'); // v0.5 名将军 1–2 章坐镇；这一步测 v0.4 的追击决策，只放开周瑜军
    const home = w.findPassableNear(Math.floor(w.mapData.grid[0].length * 0.37), Math.floor(w.mapData.grid.length * 0.28)); pl.setPosition(home.x, home.y); // 回到地图中部开阔处
    // 其他 AI 暂时移开，保证是曹操军来追
    // v0.5 地图只有 1600 px：分散到不同的远处（叠在一起会互相开战）
    const spots = [[0.1, 0.9], [0.9, 0.9], [0.9, 0.1], [0.1, 0.1], [0.5, 0.95], [0.95, 0.5], [0.05, 0.5], [0.5, 0.05], [0.75, 0.75], [0.25, 0.75], [0.75, 0.25]];
    const GW = w.mapData.grid[0].length, GH = w.mapData.grid.length;
    w.aiParties.filter(p => p.id !== 'wu_zhouyu').forEach((p, i) => { if (Math.hypot(p.x - pl.x, p.y - pl.y) < 700) { const [fx, fy] = spots[i % spots.length]; const f = w.findPassableNear(Math.floor(GW * fx), Math.floor(GH * fy)); if (f) { w.field.teleport(p, f.x, f.y); p.clearPath(); } } });
    const c = w.aiParties.find(p => p.id === 'wu_zhouyu');
    for (const ang of [0, 1.57, 3.14, 4.71, 0.78, 2.35, 3.92, 5.49]) {
      const x = pl.x + Math.cos(ang) * 220, y = pl.y + Math.sin(ang) * 220;
      const s = w.findPassableNear(Math.floor(x / T), Math.floor(y / T));
      const d = Math.hypot(s.x - pl.x, s.y - pl.y);
      const path = w.pathfinder.findPath(Math.floor(s.x / T), Math.floor(s.y / T), Math.floor(pl.x / T), Math.floor(pl.y / T));
      if (d > 180 && path && !path.partial) { c.setPosition(s.x, s.y); break; }
    }
    // v0.5 武将偏好兵种（周瑜 = 弓）让周瑜军战力更高：把玩家兵数调到战力比 ≈ 2（< chase_max_ratio 3，仍会追）
    for (let k = 0; k < 5; k++) { const r = c.power / pl.power; pl.team.soldiers = Math.max(5, Math.min(pl.cap, Math.round(pl.team.soldiers * r / 2))); pl.refresh(); w.field.refresh(pl); }
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
  await page.screenshot({ path: ART + '/screenshot-chase.png' });
  // 等战斗结束
  let after = null, engagedSeen = false;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(250);
    // v0.5 分支：战斗是持续的（弓兵会放风筝），不等结算；看到交战且兵数在掉就算
    after = await ev(() => { const w = window.__game.scene.getScene('World'), b = w.field.body(w.player.id);
      return { player: b ? Math.round(b.N0 - b.N0 * b.raw * (1 - b.stats.red)) : w.player.soldiers, engaged: !!w.player.inBattle, log: w.state.battleLog.map(e => e.text), invincible: w.player.isInvincible(w.clock.now), points: w.state.points }; });
    if (after.engaged) engagedSeen = true;
    if (after.log.some(t => t.includes('主角军')) || (engagedSeen && after.player < before.player)) break;
  }
  await page.waitForTimeout(600);
  await page.screenshot({ path: OUT });
  result.chase = { startDist: before.d, observed: chase, ok: !!chase };
  result.battle = { playerSoldiersBefore: before.player, playerSoldiersAfter: after.player, log: after.log, playerInvincibleAfter: after.invincible, points: after.points,
    engaged: engagedSeen, ok: (after.log.some(t => t.includes('主角军')) || engagedSeen) && after.player !== before.player };
  // 4) M3 抽卡：等所有战斗结束，玩家无敌，避免被打断
  // v0.5 分支：战斗是持续的（周瑜弓兵会放风筝），把玩家挪到远离所有 AI 的地方 → 间隙 > 150 px 持续 2 s 自然脱离
  await ev(() => { const w = window.__game.scene.getScene('World'), pl = w.player, T = w.tileSize;
    pl.clearPath(); pl.invincibleUntil = w.clock.now + 600000;
    let best = null, bd = -1;
    const G = w.mapData.grid; for (let ty = 5; ty < G.length - 5; ty += 6) for (let tx = 5; tx < G[0].length - 5; tx += 6) {
      const s = w.findPassableNear(tx, ty); if (!s) continue;
      const d = Math.min(...w.aiParties.map(p => Math.hypot(p.x - s.x, p.y - s.y))); if (d > bd) { bd = d; best = s; }
    }
    if (best) w.field.teleport(pl, best.x, best.y);
  });
  await page.waitForFunction(() => { const w = window.__game.scene.getScene('World'); return !w.player.inBattle && !Object.keys(w.field.state.pairs).length; }, null, { timeout: 15000 }).catch(() => {});
  // 还在交战（v0.5 小地图上更容易遇敌）：移走玩家的对手，保证下面抽卡测试不被“战斗中不能抽卡”挡住
  await ev(() => { const w = window.__game.scene.getScene('World'), b = w.field.body(w.player.id);
    for (const id of b?.foes ?? []) { const p = w.parties.find(x => x.id === id); if (p) w.removeParty(p); } });
  await page.waitForTimeout(300);
  await ev(() => { const w = window.__game.scene.getScene('World'); w.player.invincibleUntil = w.clock.now + 600000; w.state.points = 10; });
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
  // 加点：开发模式用调试钩子 / F2；生产构建（preview）里 F2 必须无效，改为直接改 state
  const isDev = await ev(() => window.__game.scene.getScene('World').debugGrantPoints(0) !== null);
  await page.keyboard.press('F2'); await page.waitForTimeout(200);
  const afterF2 = await ev(() => window.__game.scene.getScene('World').state.points);
  result.devF2 = { isDev, pointsAfterF2: afterF2, ok: isDev ? afterF2 === 210 : afterF2 === 10 };
  await ev(() => { window.__game.scene.getScene('World').state.points = 1000; });
  const hud = await ev(() => { const b = window.__game.scene.getScene('UI').gachaBtn; return { x: b.x + 60, y: b.y + 17 }; });
  await page.mouse.click(hud.x, hud.y); await page.waitForTimeout(300);
  const open = await gs();
  await page.mouse.click(open.btn.x + 120, open.btn.y + 22); await page.waitForTimeout(150);
  const rolling = await gs();
  await page.waitForTimeout(1200);
  let afterPull = await gs();
  const shownFirst = afterPull.ui; // v0.4：滚动结束先进入 RESULT 展示
  if (afterPull.ui === 'RESULT' && afterPull.result?.next) { await page.keyboard.press('Enter'); await page.waitForTimeout(300); afterPull = await gs(); }
  if (afterPull.ui === 'CHOOSE_GENERAL') { await page.keyboard.press('1'); await page.waitForTimeout(200); }
  if (afterPull.ui === 'ITEM_FULL') { await page.keyboard.press('0'); await page.waitForTimeout(200); }
  if (afterPull.ui === 'CHOOSE_UNIT') { await page.keyboard.press('0'); await page.waitForTimeout(200); } // v0.5 兵种令：不改
  if (afterPull.ui === 'ROSTER_FULL') { await page.keyboard.press('r'); await page.waitForTimeout(300); }
  afterPull = await gs();
  await page.screenshot({ path: ART + '/screenshot-gacha.png' });
  const costBase = await ev(() => window.__balance.gacha.cost_base), refundPts = await ev(() => window.__balance.gacha.duplicate_item_refund_points); // 抽到已有物品：立即返还
  result.gachaPull = { openedByMouse: open.gacha, rollingState: rolling.ui, pointsBefore: open.points, pointsAfter: afterPull.points, draws: afterPull.draws, result: afterPull.result, ui: afterPull.ui,
    shownFirst, ok: shownFirst === 'RESULT' && open.gacha && rolling.ui === 'ROLLING' && (rolling.points === 1000 - costBase || rolling.points === 1000 - costBase + refundPts) && afterPull.draws === 1 && afterPull.ui === 'RESULT' && !!afterPull.result?.text };
  // 满编替换：队伍补到 3 将，强制下一抽 = S 级武将（诸葛亮），弹出名册窗口，按 1 替换第一名随从
  await ev(() => { const w = window.__game.scene.getScene('World'); const t = w.player.team; const lib = (id) => { const g = window.__balance.generals.find(x => x.id === id); return { id: g.id, name: g.name, tier: g.tier, lead: g.lead, str: g.str, int: g.int, cha: g.cha }; };
    t.generals = t.generals.filter(g => g.id === 'hero');
    t.generals.push(lib('liaohua'), { id: 'smoke_gen', name: '波才', generic: true, lead: 30, str: 40, int: 20, cha: 20 });
    w.state.freePool = w.state.freePool.filter(id => id !== 'liaohua'); w.state.freePool.includes('zhugeliang') || w.state.freePool.push('zhugeliang');
    w.player.refresh();
    // 抽卡用存档里的 gacha 随机数流：临时换成固定序列（S 级 → 诸葛亮），之后换回
    window.__realGachaRng = w.rngs.gacha; const seq = [0.995, 0];
    w.rngs.gacha = Object.assign(() => (seq.length ? seq.shift() : window.__realGachaRng()), { getState: () => window.__realGachaRng.getState(), setState: v => window.__realGachaRng.setState(v) }); });
  await page.keyboard.press('Space'); await page.waitForTimeout(1300);
  const rfResult = await gs(); // RESULT，next = roster_full
  await page.keyboard.press('Escape'); await page.waitForTimeout(400); // esc_rule.RESULT = 确认 → 进入 ROSTER_FULL
  const rf = await gs();
  await page.screenshot({ path: ART + '/screenshot-roster.png' });
  await page.keyboard.press('1'); await page.waitForTimeout(400);
  const rep = await gs();
  await ev(() => { window.__game.scene.getScene('World').rngs.gacha = window.__realGachaRng; });
  await page.keyboard.press('Escape'); await page.waitForTimeout(300); // RESULT → IDLE
  const idle = await gs();
  await page.keyboard.press('Escape'); await page.waitForTimeout(300); // IDLE → 关闭
  const fin = await gs();
  result.gachaReplace = { rosterOpened: rf.roster, gachaPausedUnderRoster: rf.gachaPaused, uiWhileRoster: rf.ui, gensAfter: rep.gens, liaohuaInFreePool: rep.freePool.includes('liaohua'),
    resultText: rep.result?.text, worldResumed: !fin.worldPaused && !fin.gacha,
    escRule: { resultBeforeConfirm: rfResult.ui, next: rfResult.result?.next, afterEsc: rf.ui, afterSecondEsc: idle.ui, idleStillOpen: idle.gacha },
    ok: rfResult.ui === 'RESULT' && rfResult.result?.next === 'roster_full' && idle.ui === 'IDLE' && idle.gacha && rf.roster && rf.ui === 'ROSTER_FULL' && rep.gens.join() === 'hero,zhugeliang,smoke_gen' && rep.freePool.includes('liaohua') && !rep.roster && rep.ui === 'RESULT' && rep.pending === 0 && !fin.worldPaused && !fin.gacha };
  // 4b) v0.4 pause_scope：打开抽卡时整个世界冻结（游戏时钟、AI 战斗计时、无敌、刷新、自动存档）
  // v0.5 分支：战斗是 field（melee.step）里的持续接触；冻结 = 战斗时间 t / 各方 raw 都不动
  const freeze = () => ev(() => { const w = window.__game.scene.getScene('World'); const now = w.clock.now; const f = w.field;
    return { now, battleT: f.state.t, raw: Object.values(f.state.bodies).map(b => b.raw.toFixed(6)).join(' '), battles: Object.keys(f.state.pairs).length, inv: w.player.invincibleUntil - now,
      respawn: w.clock.remaining('respawn'), autosave: w.clock.remaining('autosave'), pos: w.aiParties.map(p => Math.round(p.x) + ',' + Math.round(p.y)).join(' ') }; });
  // 手动让两支不同阵营的 AI 开战，检验“别处的 AI 战斗计时”也被冻结（贴不上 / 有保护就换一对，最多试 6 对）
  for (let k = 0; k < 6; k++) {
    await ev((k) => { const w = window.__game.scene.getScene('World'), now = w.clock.now;
      const free = w.aiParties.filter(p => !p.inBattle && !p.isInvincible(now));
      const pairs = []; for (const x of free) for (const y of free) if (x.faction !== y.faction && x.id < y.id) pairs.push([x, y]);
      const [x, y] = pairs[k % Math.max(1, pairs.length)] ?? [];
      if (x && y) w.field.teleport(y, x.x + w.views.get(x).radius + w.views.get(y).radius - 2, x.y); }, k);
    await page.waitForTimeout(300);
    if (await ev(() => Object.keys(window.__game.scene.getScene('World').field.state.pairs).length > 0)) break;
  }
  await page.keyboard.press('g'); await page.waitForTimeout(200);
  const f0 = await freeze();
  await page.waitForTimeout(2000);
  const f1 = await freeze();
  await page.keyboard.press('Escape'); await page.waitForTimeout(500);
  const f2 = await freeze();
  result.pauseFreeze = { before: f0, after2sPaused: f1, afterResume: { now: f2.now, battleT: f2.battleT },
    ok: f0.battles >= 1 && JSON.stringify(f0) === JSON.stringify(f1) && f2.now > f1.now && f2.battleT > f1.battleT };
  await page.waitForFunction(() => !Object.keys(window.__game.scene.getScene('World').field.state.pairs).length, null, { timeout: 20000 }).catch(() => {});

  // 4c) 存档决定 1：抽卡结果产生后立即存档；未做的选择读档后重新弹出（不回滚）；读档后随机数流状态一致（不重掷）
  await ev(() => { const w = window.__game.scene.getScene('World'); w.state.points = 1000;
    const t = w.player.team; if (t.generals.length < 2) t.generals.push({ id: 'smoke_gen2', name: '张曼成', generic: true, lead: 30, str: 30, int: 30, cha: 30 });
    w.player.refresh(); });
  await page.keyboard.press('g'); await page.waitForTimeout(300);
  await ev(() => { const w = window.__game.scene.getScene('World'); window.__realGachaRng = w.rngs.gacha; const seq = [0.45]; // 0.45 → 属性 +5（gacha_v05 权重 38/12/…：0.38–0.50 = attr_big），多人可选 → 待选择
    w.rngs.gacha = Object.assign(() => (seq.length ? seq.shift() : window.__realGachaRng()), { getState: () => window.__realGachaRng.getState(), setState: v => window.__realGachaRng.setState(v) }); });
  await page.keyboard.press('Space'); await page.waitForTimeout(1300);
  const pendBefore = await ev(() => { const w = window.__game.scene.getScene('World'); const sv = JSON.parse(localStorage.getItem('sanguo-run-v1'));
    return { ui: window.__game.scene.getScene('Gacha').uiState, pending: w.state.gachaPending, points: w.state.points, draws: w.state.gachaDraws, rng: w.rngs.gacha.getState(),
      savedPending: sv.state.gachaPending, savedPoints: sv.state.points, savedRng: sv.rng.gacha, savedReason: sv.reason }; });
  await page.reload(); // 不做选择直接刷新（模拟崩溃 / 关闭）
  await page.waitForFunction(() => window.__game?.scene.isActive('Title'), null, { timeout: 15000 });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__game.scene.isActive('Gacha'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  const pendAfter = await ev(() => { const w = window.__game.scene.getScene('World'); const g = window.__game.scene.getScene('Gacha');
    return { gachaOpen: window.__game.scene.isActive('Gacha'), ui: g?.uiState, pending: w.state.gachaPending, points: w.state.points, draws: w.state.gachaDraws, rng: w.rngs.gacha.getState() }; });
  await page.keyboard.press('1'); await page.waitForTimeout(300);
  const chosen = await ev(() => ({ ui: window.__game.scene.getScene('Gacha').uiState, pending: window.__game.scene.getScene('World').state.gachaPending,
    savedPending: JSON.parse(localStorage.getItem('sanguo-run-v1')).state.gachaPending }));
  await page.keyboard.press('Escape'); await page.waitForTimeout(200); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  result.pendingChoiceReload = { before: { ui: pendBefore.ui, next: pendBefore.pending?.next, points: pendBefore.points, savedReason: pendBefore.savedReason },
    after: { gachaOpen: pendAfter.gachaOpen, ui: pendAfter.ui, points: pendAfter.points, draws: pendAfter.draws, rngSame: pendAfter.rng === pendBefore.rng }, chosen,
    ok: pendBefore.ui === 'RESULT' && pendBefore.pending?.next === 'choose_general' && pendBefore.savedPending?.next === 'choose_general' && pendBefore.savedPoints === pendBefore.points
      && pendBefore.savedRng === pendBefore.rng && pendAfter.gachaOpen && pendAfter.ui === 'CHOOSE_GENERAL' && pendAfter.points === pendBefore.points && pendAfter.draws === pendBefore.draws
      && pendAfter.rng === pendBefore.rng && chosen.ui === 'RESULT' && chosen.pending === null && chosen.savedPending === null };
  result.saveReasons = [...new Set(logs.saves)];
  result.saveBeforeBattle = { ok: logs.saves.includes('battle-start') && logs.saves.includes('modal') && logs.saves.includes('gacha') };
  await ev(() => { window.__game.scene.getScene('World').player.invincibleUntil = window.__game.scene.getScene('World').clock.now + 600000; });

  // 5) 存档：F5 手动存档 → 刷新页面 → 标题菜单「继续游戏」→ 状态恢复
  const SAVE_KEY = 'sanguo-run-v1';
  const readSave = () => ev(k => { const t = localStorage.getItem(k); try { return t && JSON.parse(t); } catch { return 'CORRUPT'; } }, SAVE_KEY);
  const playerState = () => ev(() => { const w = window.__game.scene.getScene('World'); const p = w.player;
    return { points: w.state.points, draws: w.state.gachaDraws, soldiers: p.team.soldiers, x: p.x, y: p.y, gens: p.team.generals.map(g => [g.id, g.lead, g.str, g.int, g.cha]),
      items: p.team.items.slice(), freePool: w.state.freePool.slice().sort(), ai: w.aiParties.length, battles: w.state.battles, log: w.state.battleLog.length }; });
  await ev(() => localStorage.removeItem('sanguo-run-v1'));
  // 等控制台出现新的 “[save] manual”（之后可能马上有别的原因的存档覆盖 reason，所以不按 localStorage 里的 reason 判断）
  const nManual = () => logs.saves.filter(r => r === 'manual').length, m0 = nManual();
  await page.keyboard.press('F5');
  let manual = null;
  for (let i = 0; i < 60 && !manual; i++) { await page.waitForTimeout(250); if (nManual() > m0) manual = await readSave(); }
  const beforeReload = await playerState();
  await page.reload();
  await page.waitForFunction(() => window.__game?.scene.isActive('Title'), null, { timeout: 15000 });
  await page.waitForTimeout(300);
  const savedOnUnload = await readSave();
  await page.screenshot({ path: ART + '/screenshot-title.png' });
  const cont = await ev(() => { const b = window.__game.scene.getScene('Title').btnContinue; return b && { x: b.x + 120, y: b.y + 23 }; });
  await page.mouse.click(cont.x, cont.y);
  await page.waitForFunction(() => window.__game.scene.getScene('World')?.player && window.__game.scene.isActive('UI'), null, { timeout: 15000 });
  await page.waitForTimeout(300);
  const restored = await playerState();
  const sameish = (a, b) => a.points === b.points && a.draws === b.draws && a.soldiers === b.soldiers && JSON.stringify(a.gens) === JSON.stringify(b.gens)
    && JSON.stringify(a.items) === JSON.stringify(b.items) && JSON.stringify(a.freePool) === JSON.stringify(b.freePool) && Math.hypot(a.x - b.x, a.y - b.y) < 8;
  result.saveReload = { manualSaveWritten: !!manual, saveVersion: manual?.saveVersion, balanceVersion: manual?.balanceVersion, unloadReason: savedOnUnload?.reason,
    before: { points: beforeReload.points, soldiers: beforeReload.soldiers, x: Math.round(beforeReload.x), y: Math.round(beforeReload.y), gens: beforeReload.gens.map(g => g[0]), items: beforeReload.items, ai: beforeReload.ai },
    after: { points: restored.points, soldiers: restored.soldiers, x: Math.round(restored.x), y: Math.round(restored.y), gens: restored.gens.map(g => g[0]), items: restored.items, ai: restored.ai },
    ok: !!manual && !!cont && sameish(beforeReload, restored) && restored.ai === (savedOnUnload?.ai?.length ?? -1) && restored.log === beforeReload.log };
  // F9 读档：改动点数后读档 → 恢复为存档里的点数
  const savedPts = (await readSave()).state.points;
  await ev(() => { window.__game.scene.getScene('World').state.points += 77; });
  await page.keyboard.press('F9');
  await page.waitForTimeout(800);
  const afterF9 = await playerState();
  result.f9Load = { savedPoints: savedPts, afterF9: afterF9.points, ok: afterF9.points === savedPts };
  // 损坏存档：标题显示错误，只能新游戏（确认后清档）
  // 先禁止本页再存档（否则刷新时的自动存档会覆盖掉损坏数据），再写入损坏存档
  await ev(() => { window.__game.scene.getScene('World').canSaveNow = () => false; localStorage.setItem('sanguo-run-v1', '{"saveVersion":1, broken'); });
  await page.reload();
  await page.waitForFunction(() => window.__game?.scene.isActive('Title'), null, { timeout: 15000 });
  await page.waitForTimeout(300);
  const corrupt = await ev(() => { const t = window.__game.scene.getScene('Title'); return { loadedOk: t.result.ok, code: t.result.code, msg: t.result.message, hasContinue: !!t.btnContinue }; });
  await page.screenshot({ path: ART + '/screenshot-title-corrupt.png' });
  // v0.5 标题：损坏 / 不兼容的存档没有“继续”，新一局面板直接 Enter 开始（会清掉坏档；没有可丢的进度，不再确认）
  const confirming = await ev(() => !window.__game.scene.getScene('Title').hasRun && !!window.__game.scene.getScene('Title').btnNew);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__game.scene.getScene('World')?.player && window.__game.scene.isActive('UI'), null, { timeout: 15000 });
  const fresh = await playerState();
  result.corruptSave = { ...corrupt, confirming, freshPoints: fresh.points, freshDraws: fresh.draws, ok: !corrupt.loadedOk && corrupt.code === 'corrupt' && !corrupt.hasContinue && confirming && fresh.points === 0 && fresh.draws === 0 };

  result.consoleBattles = logs.battleEnd.slice(0, 6);
  result.aiTransitions = logs.ai.slice(0, 8);
  result.errors = errors;
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  const ok = !errors.length && result.keyboard.ok && result.inputActions.ok && result.clickAroundObstacle.ok && result.chase.ok && result.battle.ok && result.gachaInsufficient.ok && result.gachaPull.ok && result.gachaReplace.ok && result.devF2.ok && result.pauseFreeze.ok && result.pendingChoiceReload.ok && result.saveBeforeBattle.ok && result.saveReload.ok && result.f9Load.ok && result.corruptSave.ok;
  console.log(ok ? 'SMOKE OK' : 'SMOKE FAIL');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
