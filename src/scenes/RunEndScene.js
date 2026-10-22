import { createSceneInput, ACTIONS } from '../platform/input.js';
import Phaser from 'phaser';
import { run as runCfg, balance } from '../data/index.js';
import { button, text } from '../ui/widgets.js';

const fmtS = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
/** 名将军显示名：首位武将 + “军”（initial_teams 里没有队名） */
export function namedArmyName(id) {
  const t = balance.initial_teams.find(x => x.id === id), g0 = t?.generals?.[0];
  const g = balance.generals.find(x => x.id === (g0?.id ?? g0));
  return g ? `${g.name}军` : id;
}
const REASON = { soldiers: '兵力耗尽', hero_hp: '主角重伤不起', abandon: '放弃本局', all_named: '四路名将尽数讨平' };

/**
 * 结算画面（失败 / 胜利，Phaser 绘制）。到这里时 run 存档已删除、局外数据已写入（WorldScene.endRun）。
 * Enter = 再来一局（同样的开局选项）；Esc = 回标题。
 */
export default class RunEndScene extends Phaser.Scene {
  constructor() { super('RunEnd'); }

  init(data) { this.d = data; }

  create() {
    const act = createSceneInput(this, { pointer: false });
    act.on(ACTIONS.CONFIRM, () => this.restart());
    act.on(ACTIONS.CANCEL, () => this.toTitle());
    this.render();
    this.scale.on('resize', this.render, this);
    this.events.once('shutdown', () => this.scale.off('resize', this.render, this));
  }

  restart() { this.scene.start('World', { newRun: this.d.opts ?? {} }); }
  toTitle() { this.scene.start('Title', {}); }

  render() {
    this.children.removeAll(true);
    const { width: w, height: h } = this.scale, cx = w / 2, s = this.d.summary, win = s.result === 'victory';
    this.add.rectangle(0, 0, w, h, win ? 0x14210f : 0x1d1010).setOrigin(0);
    text(this, cx, h * 0.14, win ? '天下归心' : '兵败', 44, win ? '#f1c40f' : '#e74c3c').setOrigin(0.5);
    text(this, cx, h * 0.14 + 46, REASON[s.reason] ?? s.reason ?? '', 18, '#dddddd').setOrigin(0.5);
    const named = runCfg.run_goal.named.map(id => {
      return `${s.namedDefeated.includes(id) ? '✔' : '✘'} ${namedArmyName(id)}`;
    }).join('   ');
    const rows = [
      ['存活', `${fmtS(s.survivedS)} / ${runCfg.duration_min}:00`],
      ['到达', `第 ${s.chapterReached} 章 · ${runCfg.chapters[s.chapterReached - 1]?.name ?? ''}`],
      ['讨平名将', `${s.namedDefeated.length} / ${runCfg.run_goal.named.length}`],
      ['', named],
      ['最高战力', String(s.maxPower)],
      ['战斗', `${s.battles} 场，胜 ${s.battlesWon}`],
      ['名望', `+${s.fame}（累计 ${this.d.meta?.fameTotal ?? s.fame}）`],
      ['种子', `${s.runSeed}${s.hard ? ' · 群雄模式' : ''}`]
    ];
    let y = h * 0.32;
    for (const [k, v] of rows) {
      if (k) text(this, cx - 60, y, k, 16, '#8fa3b8').setOrigin(1, 0);
      text(this, cx - 40, y, v, 16, '#ffffff');
      y += 26;
    }
    if (this.d.newUnlocks?.length) {
      text(this, cx, y + 10, `新解锁：${this.d.newUnlocks.map(u => u.name).join('、')}`, 16, '#ffdd55').setOrigin(0.5);
      y += 34;
    }
    this.btnRestart = button(this, cx - 250, y + 24, 240, 46, '再来一局 [Enter]', () => this.restart(), { color: 0x8e5a00, size: 18 });
    this.btnTitle = button(this, cx + 10, y + 24, 240, 46, '回标题 [Esc]', () => this.toTitle(), { size: 18 });
  }
}
