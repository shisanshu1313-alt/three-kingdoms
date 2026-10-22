// v0.5 一局 冒烟：开新局 → 快进游戏时钟（开发钩子 debugAdvance，按固定 tick 跑完整模拟）→ ~20 s 开局遭遇战（来袭黄巾冲玩家并交战）
// → 主角 HP 归零 → 失败：run 存档被删除、局外数据写入、显示结算画面 → 再来一局可以正常开始。
// 用法：node tests/smoke-run.cjs [url]（默认 http://localhost:5180/）；截图：/workspace/v05-run-screenshot.png + artifacts/
const path = require('path');
const { chromium } = require(process.env.PW_CORE || '/workspace/.tools/node_modules/playwright-core');
const URL = process.argv[2] || 'http://localhost:5180/';
const OUT = path.join(__dirname, '..', 'artifacts');
const SHOT = process.env.RUN_SHOT || '/workspace/v05-run-screenshot.png';
const sleep = (p, ms) => p.waitForTimeout(ms);
(async () => {
  require('fs').mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1200, height: 760 } });
  const errs = [], logs = [];
  p.on('pageerror', e => errs.push(String(e)));
  p.on('console', m => { logs.push(m.text()); if (m.type() === 'error') errs.push(m.text()); });
  const fail = async (msg) => { console.error('FAIL:', msg); console.error(logs.slice(-40).join('\n')); await p.screenshot({ path: path.join(OUT, 'run-fail.png') }); await b.close(); process.exit(1); };
  const ok = (c, msg) => (c ? console.log('ok  ', msg) : fail(msg));
  const W = fn => p.evaluate(fn);

  // 旧版存档：放一个 v0.4 的 sanguo-save → 启动时应归档为 sanguo-save-legacy 并提示
  await p.goto(URL); await W(() => { localStorage.clear(); localStorage.setItem('sanguo-save', '{"saveVersion":3,"old":true}'); }); await p.reload(); await sleep(p, 2500);
  const leg = await W(() => ({ title: __game.scene.isActive('Title'), legacy: localStorage.getItem('sanguo-save-legacy'), old: localStorage.getItem('sanguo-save') }));
  await ok(leg.title && leg.legacy && leg.old === null, `旧版存档归档为 sanguo-save-legacy，标题页提示（${JSON.stringify(leg)}）`);
  await p.keyboard.press('Enter'); await sleep(p, 2000);

  const run0 = await W(() => { const w = __game.scene.getScene('World'); return { active: __game.scene.isActive('World'), runId: w.run.runId, t: w.clock.now / 1000, ch: w.run.chapter, grace: w.aiSystem.rules.graceUntilS, hp: w.run.heroHp }; });
  await ok(run0.active && run0.runId && run0.ch === 0 && run0.grace === 90 && run0.hp === 100, `新一局开始（${JSON.stringify(run0)}）`);
  await W(() => __game.scene.pause('World')); // 下面只用快进推进，避免真实时间干扰

  // 19 s：还没有来袭；推进到 20 s：来袭黄巾出现在 350–450 px
  const before = await W(() => { const w = __game.scene.getScene('World'); w.debugAdvance(19 - w.clock.now / 1000); return { t: w.clock.now / 1000, raid: w.run.raidId }; });
  await ok(!before.raid, `19 s 时尚无开局遭遇战（t=${before.t.toFixed(1)}）`);
  const raid = await W(() => {
    const w = __game.scene.getScene('World');
    while (!w.run.raidId && w.clock.now < 25000) w.debugAdvance(0.1);
    const r = w.aiParties.find(a => a.id === w.run.raidId), pl = w.player;
    return r && { t: w.clock.now / 1000, id: r.id, name: r.name, dist: Math.hypot(r.x - pl.x, r.y - pl.y), ratio: r.power / pl.power, raid: !!r.team.raid, state: r.ai?.state };
  });
  await ok(raid && Math.abs(raid.t - 20) < 0.25 && raid.dist >= 340 && raid.dist <= 460 && raid.ratio > 0.5 && raid.ratio < 0.95, `20 s 刷出来袭黄巾（${JSON.stringify(raid)}）`);
  const fight = await W(() => {
    const w = __game.scene.getScene('World'), id = w.run.raidId;
    for (let i = 0; i < 300; i++) {
      w.debugAdvance(0.1);
      const pairs = Object.values(w.field.state.pairs).filter(q => (q.a === id || q.b === id) && (q.a === w.player.id || q.b === w.player.id));
      if (pairs.length) return { t: w.clock.now / 1000, inBattle: w.player.inBattle, otherChasers: w.aiParties.filter(a => a.id !== id && a.ai?.state === 'chase' && a.ai.targetId === 'player').length };
    }
    return null;
  });
  await ok(fight && fight.inBattle && fight.t < 50, `开局遭遇战：来袭队冲到玩家并交战（${JSON.stringify(fight)}）`);
  await ok(fight.otherChasers === 0, '新手保护（90 s）内其他 AI 不追玩家');
  await W(() => __game.scene.resume('World')); await sleep(p, 700);
  await W(() => __game.scene.pause('World'));
  await p.screenshot({ path: SHOT });
  console.log('screenshot', SHOT);
  const saved = await W(() => { const t = localStorage.getItem('sanguo-run-v1'); const s = t && JSON.parse(t); return s && { v: s.saveVersion, runId: s.run?.runId, reason: s.reason, combat: !!s.combat }; });
  await ok(saved && saved.v === 4 && saved.runId === run0.runId && saved.combat, `交战中 run 存档（sanguo-run-v1，含战斗快照）存在（${JSON.stringify(saved)}）`);

  // 死亡：主角 HP 归零 → 下一 tick 失败 → 删档 → 局外数据 → 结算画面
  const dead = await W(() => { const w = __game.scene.getScene('World'); w.debugSetHeroHp(0); w.debugAdvance(0.2); __game.scene.resume('World'); return true; });
  await sleep(p, 1200);
  const after = await W(() => ({ end: __game.scene.isActive('RunEnd'), world: __game.scene.isActive('World'), save: localStorage.getItem('sanguo-run-v1'), meta: JSON.parse(localStorage.getItem('sanguo-meta-v1') || 'null') }));
  await ok(dead && after.end && !after.world, '主角 HP 0 → 结算画面（失败）');
  await ok(after.save === null, '死亡后 run 存档已删除');
  await ok(after.meta && after.meta.runs === 1 && after.meta.recordedRunIds.includes(run0.runId) && after.meta.fameTotal > 0, `局外数据写入（runs=${after.meta?.runs} fame=${after.meta?.fameTotal}）`);
  await p.screenshot({ path: path.join(OUT, 'run-gameover.png') });
  // 刷新页面：没有 run 存档 → 不会“继续”死掉的那局
  await sleep(p, 300);

  // 再来一局
  await p.keyboard.press('Enter'); await sleep(p, 2000);
  const run1 = await W(() => { const w = __game.scene.getScene('World'); return { active: __game.scene.isActive('World'), runId: w.run.runId, t: w.clock.now / 1000, hp: w.run.heroHp, over: w.run.over, soldiers: w.player.team.soldiers }; });
  await ok(run1.active && run1.runId !== run0.runId && run1.t < 5 && run1.hp === 100 && !run1.over && run1.soldiers > 0, `再来一局（${JSON.stringify(run1)}）`);
  // 城池整编：开局在洛阳城内；B → 2（骑兵）：−30 点、兵种改变、5 s 不能移动
  await W(() => { const w = __game.scene.getScene('World'); w.state.points = 100; });
  await p.keyboard.press('b'); await sleep(p, 200); await p.keyboard.press('2'); await sleep(p, 300);
  const reorg = await W(() => { const w = __game.scene.getScene('World'); return { unit: w.player.team.unit, body: w.field.body(w.player.id).unit, points: w.state.points, locked: (w.player.team.lockUntil ?? 0) > w.clock.now }; });
  await ok(reorg.unit === 'cav' && reorg.body === 'cav' && reorg.points === 70 && reorg.locked, `城池整编：B → 骑兵（${JSON.stringify(reorg)}）`);
  await p.keyboard.press('p'); await sleep(p, 400);
  const paused = await W(() => __game.scene.isPaused('World'));
  await p.keyboard.press('Escape'); await sleep(p, 300);
  await ok(paused && !(await W(() => __game.scene.isPaused('World'))), '暂停菜单 P 打开 / Esc 关闭');
  // 刷新页面 → 标题页有“继续”（同一 runId）
  await W(() => __game.scene.getScene('World').trySaveNow('manual')); await p.reload(); await sleep(p, 2500);
  const cont = await W(() => ({ title: __game.scene.isActive('Title'), hasRun: __game.scene.getScene('Title').hasRun }));
  await ok(cont.title && cont.hasRun, '刷新后标题页可以继续进行中的一局');
  await p.keyboard.press('Enter'); await sleep(p, 1500);
  const run2 = await W(() => __game.scene.getScene('World').run.runId);
  await ok(run2 === run1.runId, '继续 = 同一局');

  const bad = errs.filter(e => !/favicon|DevTools/.test(e));
  await ok(bad.length === 0, `无页面错误${bad.length ? '：' + bad.join(' | ') : ''}`);
  console.log('SMOKE-RUN PASS');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
