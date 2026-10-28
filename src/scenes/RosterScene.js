import { createSceneInput, ACTIONS } from '../platform/input.js';
import Phaser from 'phaser';
import { balance } from '../data/index.js';
import { resolvePending, replaceableIndices, canStore, exilePoints, storeCap, pendingPreview, rosterFlowStep, newRosterFlow } from '../systems/roster.js';
import { getLeader } from '../systems/leader.js';
import { computePower } from '../systems/combat.js';
import { button, text, generalLine, tierColor } from '../ui/widgets.js';

const W = 760, H = 460;

/**
 * v0.6 新武将弹窗（roster_v06.new_general_flow）：队伍已满（主角 + 2 副将）时得到新武将，必须当场选：
 *   替换副将（换下的人：回主城存放 / 流放）、送回主城（要有主城且有空位）、流放（回自由池 +20 点）。
 *   界面状态 PENDING_GENERAL → CHOOSE_REPLACE → CHOOSE_DEST → DONE（systems/roster.js rosterFlowStep），每次完成自动存档。
 * 键盘（platform/input.js 动作）：1/2 选副将（= 替换它）、E 替换副将、H 送回主城 / 回主城存放、
 *   R 流放（先到确认页，再按 R / Enter 确认；Esc 取消；A/S 级名字红字）、Esc 返回上一步。鼠标：点卡片 / 按钮。
 */
export default class RosterScene extends Phaser.Scene {
  constructor() { super('Roster'); }

  init(data) { this.returnTo = data?.returnTo ?? null; this.world = this.scene.get('World'); this.flow = newRosterFlow(); }

  create() {
    const { width, height } = this.scale;
    this.ox = Math.round((width - W) / 2); this.oy = Math.round((height - H) / 2);
    this.add.rectangle(0, 0, width, height, 0x000000, 0.65).setOrigin(0).setInteractive();
    this.add.rectangle(this.ox, this.oy, W, H, 0x1f1b2a, 0.98).setOrigin(0).setStrokeStyle(2, 0xe67e22);
    this.dyn = this.add.container(0, 0);
    const act = createSceneInput(this, { pointer: false });
    act.on(ACTIONS.RELEASE, () => this.input6({ type: 'exile' }));
    act.on(ACTIONS.CONFIRM, () => this.input6({ type: 'confirm' })); // 流放确认页：Enter 同再按 R
    act.on(ACTIONS.CITY, () => this.input6({ type: 'to_city' }));
    act.on(ACTIONS.REPLACE, () => this.input6({ type: 'replace' }));
    act.on(ACTIONS.CANCEL, () => this.input6({ type: 'back' }));
    act.on(ACTIONS.CHOOSE, ({ n }) => {
      const reps = replaceableIndices(this.team, balance);
      if (n >= 1 && n <= reps.length) this.input6({ type: 'pick', index: reps[n - 1] });
    });
    this.render();
  }

  get st() { return this.world.state; }
  get team() { return this.world.player.team; }

  ctx() { return { canCity: canStore(this.st, balance), replaceable: replaceableIndices(this.team, balance) }; }

  input6(inp) {
    if (!this.st.pendingGenerals.length) return;
    this.flow = rosterFlowStep(this.flow, inp, this.ctx());
    if (this.flow.resolve) { const [a, i, o] = this.flow.resolve; return this.act(a, i, o); }
    this.render();
  }

  act(action, index, opts) {
    if (!this.st.pendingGenerals.length) return;
    const r = resolvePending(this.st, this.team, action, index, balance, opts);
    this.st.lastRosterText = r.text;
    this.world.player.refresh();
    this.world.trySaveNow('roster'); // DONE → 自动存档（世界暂停中，等不到下一帧）
    console.log(`[roster] ${r.text}`);
    this.game.events.emit('roster-resolved', r);
    this.flow = newRosterFlow();
    if (this.st.pendingGenerals.length) return this.render();
    this.scene.stop();
    if (this.returnTo) this.scene.resume(this.returnTo);
    else this.game.events.emit('modal-closed', 'Roster');
  }

  render() {
    this.dyn.removeAll(true);
    const add = o => { this.dyn.add(o); return o; };
    const entry = this.st.pendingGenerals[0];
    if (!entry) return;
    const x0 = this.ox + 24, y0 = this.oy + 16, team = this.team, g = entry.general, ui = this.flow.ui;
    const left = this.st.pendingGenerals.length - 1, ctx = this.ctx(), pv = pendingPreview(team, g, balance, computePower);
    const P = x => Math.round(x);
    add(text(this, x0, y0, `队伍已满（${balance.team_rules.max_generals} 将：主角 + ${balance.team_rules.max_generals - 1} 副将）：安排新武将${left ? `（之后还有 ${left} 名）` : ''}`, 19, '#e67e22'));
    // 新武将卡
    add(this.add.rectangle(x0, y0 + 38, 56, 70, tierColor(g)).setOrigin(0).setStrokeStyle(2, 0xffffff));
    add(text(this, x0 + 28, y0 + 73, g.tier ?? '头目', g.tier ? 24 : 13, '#000000').setOrigin(0.5));
    add(text(this, x0 + 70, y0 + 40, `新武将：${g.name}${g.tier ? `（${g.tier}）` : g.generic ? '（黄巾头目）' : ''}`, 17));
    add(text(this, x0 + 70, y0 + 64, generalLine(g), 14, '#dddddd'));
    add(text(this, x0 + 70, y0 + 86, `来源：${entry.source === 'capture' ? `俘获自 ${entry.from ?? '敌军'}` : '抽卡'}   现在战力 ${P(pv.now)}`, 13, '#aaaaaa'));

    // 副将卡（★ 统帅 = 主角，不可换下）；确认流放页不画副将卡，只画确认文案
    const hint = { PENDING_GENERAL: '点副将卡或按 1/2 = 换下他（E 先选再定）', CHOOSE_REPLACE: '选择要换下的副将：1/2 或点卡片（Esc 返回）',
      CHOOSE_DEST: `${team.generals[this.flow.replaceIdx]?.name ?? ''} 换下后去哪里？（Esc 返回）`,
      CONFIRM_EXILE: '再按 R / Enter 确认流放，Esc 取消' }[ui];
    add(text(this, x0, y0 + 122, `★ 统帅 ${getLeader(team, balance)?.name ?? '-'}（不可换下）   ${hint}`, 14, '#f1c40f'));
    if (ui !== 'CONFIRM_EXILE') {
      pv.replace.forEach((r, k) => {
        const oldG = team.generals[r.index], cx = x0 + k * 360, cy = y0 + 148, sel = this.flow.replaceIdx === r.index;
        const card = add(this.add.rectangle(cx, cy, 340, 92, sel ? 0x3d5a80 : 0x2c2838).setOrigin(0)
          .setStrokeStyle(2, sel ? 0xf1c40f : ui === 'CHOOSE_REPLACE' ? 0xe67e22 : 0x666666));
        card.setInteractive({ useHandCursor: true }).on('pointerdown', (p, lx, ly, ev) => { ev?.stopPropagation?.(); this.input6({ type: 'pick', index: r.index }); });
        add(this.add.rectangle(cx + 10, cy + 12, 14, 14, tierColor(oldG)).setOrigin(0));
        add(text(this, cx + 30, cy + 8, `[${k + 1}] 副将 ${generalLine(oldG)}`, 14));
        add(text(this, cx + 30, cy + 34, `换下后战力 ${P(r.before)} → ${P(r.after)}`, 15, r.after >= r.before ? '#66ee66' : '#ff8866'));
        add(text(this, cx + 30, cy + 60, `（${g.name} 顶替 ${oldG.name}）`, 12, '#aaaaaa'));
      });
    }

    // 按钮行
    const by = this.oy + H - 112, store = this.st.cityStore?.length ?? 0, cap = storeCap(balance);
    const cityHint = !this.st.homeCity ? '攻下一座城就能存放武将' : !ctx.canCity ? `主城已满（${store}/${cap}）` : `主城存放 ${store}/${cap}`;
    const pts = exilePoints(balance); // 设计 / 实际都是 +20；去向页标签曾被误读，只用 exilePoints
    const nameColor = g0 => (g0?.tier === 'A' || g0?.tier === 'S') ? '#ff5555' : '#ffffff';
    if (ui === 'CONFIRM_EXILE') {
      const who = this.flow.confirmKind === 'exile_replaced' ? team.generals[this.flow.replaceIdx] : g;
      const tier = who?.tier ? `（${who.tier}）` : who?.generic ? '（黄巾头目）' : '';
      add(text(this, x0, y0 + 160, '确认流放？', 22, '#e67e22'));
      add(text(this, x0, y0 + 200, `${who?.name ?? '?'}${tier}`, 28, nameColor(who)));
      add(text(this, x0, y0 + 240, `回自由池，+${pts} 点`, 16, '#dddddd'));
      add(button(this, x0, by, 340, 44, `[R / Enter] 确认流放（+${pts} 点）`, () => this.input6({ type: 'confirm' }), { color: 0x7f3b3b }));
      add(button(this, x0 + 360, by, 340, 44, '[Esc] 取消', () => this.input6({ type: 'back' })));
      return;
    }
    if (ui === 'CHOOSE_DEST') {
      const oldG = team.generals[this.flow.replaceIdx];
      add(button(this, x0, by, 340, 44, `[H] ${oldG.name} 回主城存放`, () => this.input6({ type: 'to_city' }), { enabled: ctx.canCity }));
      // 去向页流放：标签固定用 exilePoints（20）；名字另用红字标 A/S（确认页再显一次）
      add(button(this, x0 + 360, by, 340, 44, `[R] 流放（+${pts} 点）`, () => this.input6({ type: 'exile' }), { color: 0x7f3b3b }));
      add(text(this, x0 + 360, by - 22, oldG.name + (oldG.tier ? `（${oldG.tier}）` : ''), 14, nameColor(oldG)));
      add(text(this, x0, by + 50, cityHint, 13, ctx.canCity ? '#aaaaaa' : '#e67e22'));
      add(button(this, this.ox + W - 120, this.oy + H - 50, 96, 34, '[Esc] 返回', () => this.input6({ type: 'back' }), { size: 13 }));
      return;
    }
    add(button(this, x0, by, 220, 44, '[E] 替换副将', () => this.input6({ type: 'replace' })));
    add(text(this, x0, by + 50, '换下后战力见上方卡片', 12, '#aaaaaa'));
    add(button(this, x0 + 240, by, 220, 44, `[H] 送回主城`, () => this.input6({ type: 'to_city' }), { enabled: ctx.canCity }));
    add(text(this, x0 + 240, by + 50, `${cityHint}；战力不变 ${P(pv.now)}`, 12, ctx.canCity ? '#aaaaaa' : '#e67e22'));
    add(button(this, x0 + 480, by, 230, 44, `[R] 流放（+${pts} 点）`, () => this.input6({ type: 'exile' }), { color: 0x7f3b3b }));
    add(text(this, x0 + 480, by + 50, `回自由池；战力不变 ${P(pv.now)}`, 12, '#aaaaaa'));
    add(text(this, x0, this.oy + H - 26, '必须当场选择，不能关闭', 12, '#888888'));

  }
}
