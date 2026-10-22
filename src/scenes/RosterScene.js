import Phaser from 'phaser';
import { balance } from '../data/index.js';
import { resolvePending, replaceableIndices } from '../systems/roster.js';
import { mainGeneral } from '../systems/combat.js';
import { button, text, generalLine, tierColor } from '../ui/widgets.js';

const W = 760, H = 440;

/**
 * 队伍已满：替换 / 释放（balance.roster）。必须当场选择，不能关闭（no_defer）；pending_generals 先进先出逐个处理。
 * 键盘：1/2 替换对应随从；R 释放新武将。鼠标：点按钮。
 */
export default class RosterScene extends Phaser.Scene {
  constructor() { super('Roster'); }

  init(data) { this.returnTo = data?.returnTo ?? null; this.world = this.scene.get('World'); }

  create() {
    const { width, height } = this.scale;
    this.ox = Math.round((width - W) / 2); this.oy = Math.round((height - H) / 2);
    this.add.rectangle(0, 0, width, height, 0x000000, 0.65).setOrigin(0).setInteractive();
    this.add.rectangle(this.ox, this.oy, W, H, 0x1f1b2a, 0.98).setOrigin(0).setStrokeStyle(2, 0xe67e22);
    this.dyn = this.add.container(0, 0);
    this.input.keyboard.on('keydown', e => this.onKey(e));
    this.render();
  }

  get st() { return this.world.state; }
  get team() { return this.world.player.team; }

  onKey(e) {
    const k = e.key;
    if (k === 'r' || k === 'R') return this.act('release');
    const n = Number(k), reps = replaceableIndices(this.team, balance);
    if (n >= 1 && n <= reps.length) this.act('replace', reps[n - 1]);
  }

  act(action, index) {
    if (!this.st.pendingGenerals.length) return;
    const r = resolvePending(this.st, this.team, action, index, balance);
    this.st.lastRosterText = r.text;
    this.world.player.refresh();
    this.world.trySaveNow('roster'); // 每做完一个选择立即存档（世界暂停中，等不到下一帧）
    console.log(`[roster] ${r.text}`);
    this.game.events.emit('roster-resolved', r);
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
    const x0 = this.ox + 24, y0 = this.oy + 18, team = this.team, g = entry.general;
    const left = this.st.pendingGenerals.length - 1;
    add(text(this, x0, y0, `队伍已满（${balance.team_rules.max_generals} 将）：安排新武将${left ? `（之后还有 ${left} 名）` : ''}`, 20, '#e67e22'));
    // 新武将
    add(this.add.rectangle(x0, y0 + 44, 60, 76, tierColor(g)).setOrigin(0).setStrokeStyle(2, 0xffffff));
    add(text(this, x0 + 30, y0 + 82, g.tier ?? '头目', g.tier ? 26 : 14, '#000000').setOrigin(0.5));
    add(text(this, x0 + 76, y0 + 46, `新武将：${g.name}${g.tier ? `（${g.tier}）` : g.generic ? '（黄巾头目）' : ''}`, 17));
    add(text(this, x0 + 76, y0 + 72, generalLine(g), 14, '#dddddd'));
    add(text(this, x0 + 76, y0 + 96, `来源：${entry.source === 'capture' ? `俘获自 ${entry.from ?? '敌军'}` : '抽卡'}`, 14, '#aaaaaa'));

    // 随从（主角不可替换）
    add(text(this, x0, y0 + 140, '替换一名随从（主角不可替换）：', 15, '#f1c40f'));
    const curMain = mainGeneral(team, balance);
    replaceableIndices(team, balance).forEach((i, k) => {
      const old = team.generals[i], y = y0 + 170 + k * 64;
      add(this.add.rectangle(x0, y + 4, 14, 14, tierColor(old)).setOrigin(0));
      add(text(this, x0 + 22, y, generalLine(old, { main: old === curMain }), 14));
      const after = { ...team, generals: team.generals.map((x, j) => (j === i ? g : x)) };
      const newMain = mainGeneral(after, balance);
      const fate = old.generic ? '头目离去' : '回自由池';
      add(text(this, x0 + 22, y + 22, `替换后：${old.name}${fate}${newMain.id !== curMain.id ? `；主将变为 ${newMain.name}` : ''}`, 12, '#aaaaaa'));
      add(button(this, this.ox + W - 200, y, 176, 40, `[${k + 1}] 替换 ${old.name}`, () => this.act('replace', i)));
    });
    // 释放
    const ry = this.oy + H - 64;
    const fate = g.generic ? '头目离去' : '回自由池';
    add(button(this, x0, ry, 300, 44, `[R] 释放 ${g.name}（+${balance.rewards.release_captive_points} 点，${fate}）`, () => this.act('release'), { color: 0x7f3b3b }));
    add(text(this, x0 + 320, ry + 12, '必须当场选择，不能关闭', 13, '#888888'));
  }
}
