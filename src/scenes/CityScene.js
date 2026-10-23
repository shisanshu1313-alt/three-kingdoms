import { createSceneInput, ACTIONS } from '../platform/input.js';
import Phaser from 'phaser';
import { balance } from '../data/index.js';
import { swapWithStore, replaceableIndices, storeCap } from '../systems/roster.js';
import { computePower } from '../systems/combat.js';
import { button, text, generalLine, tierColor } from '../ui/widgets.js';

const W = 760, H = 440;

/**
 * v0.6 主城存放（roster_v06.storage）：在主城 swap_radius_px 内、不在战斗中按 H 打开（UIScene 判断条件，世界暂停）。
 * 左列 = 副将（1/2），右列 = 存放的武将（3/4/5）；各选 0~1 个后 Enter：
 *   副将 + 存放 = 对调；只选副将 = 存进主城；只选存放 = 出城入队（队伍要有空位）。Esc 关闭。
 */
export default class CityScene extends Phaser.Scene {
  constructor() { super('City'); }

  init() { this.world = this.scene.get('World'); this.selT = null; this.selS = null; this.msg = ''; }

  create() {
    const { width, height } = this.scale;
    this.ox = Math.round((width - W) / 2); this.oy = Math.round((height - H) / 2);
    this.add.rectangle(0, 0, width, height, 0x000000, 0.6).setOrigin(0).setInteractive();
    this.add.rectangle(this.ox, this.oy, W, H, 0x1b2a1f, 0.98).setOrigin(0).setStrokeStyle(2, 0x2ecc71);
    this.dyn = this.add.container(0, 0);
    const act = createSceneInput(this, { pointer: false });
    act.on(ACTIONS.CANCEL, () => this.close());
    act.on(ACTIONS.CONFIRM, () => this.execute());
    act.on(ACTIONS.CHOOSE, ({ n }) => {
      const reps = replaceableIndices(this.team, balance);
      if (n >= 1 && n <= 2 && reps[n - 1] !== undefined) this.selT = this.selT === reps[n - 1] ? null : reps[n - 1];
      else if (n >= 3 && n - 3 < (this.st.cityStore?.length ?? 0)) this.selS = this.selS === n - 3 ? null : n - 3;
      else return;
      this.msg = ''; this.render();
    });
    this.render();
  }

  get st() { return this.world.state; }
  get team() { return this.world.player.team; }

  actionLabel() {
    const hasT = this.selT != null, hasS = this.selS != null;
    if (hasT && hasS) return `对调：${this.team.generals[this.selT].name} ⇄ ${this.st.cityStore[this.selS].name}`;
    if (hasT) return `存进主城：${this.team.generals[this.selT].name}`;
    if (hasS) return `出城入队：${this.st.cityStore[this.selS].name}`;
    return '先选武将';
  }

  execute() {
    if (this.selT == null && this.selS == null) return;
    try {
      const r = swapWithStore(this.st, this.team, this.selT ?? undefined, this.selS ?? undefined, balance);
      this.world.player.refresh(); this.world.field.refresh(this.world.player);
      this.world.trySaveNow('city-store');
      this.msg = r.text; this.selT = null; this.selS = null;
      console.log(`[city] ${r.text}`);
      this.game.events.emit('city-store', r);
    } catch (e) { this.msg = e.message; }
    this.render();
  }

  close() { this.scene.stop(); this.game.events.emit('modal-closed', 'City'); }

  render() {
    this.dyn.removeAll(true);
    const add = o => { this.dyn.add(o); return o; };
    const x0 = this.ox + 24, y0 = this.oy + 16, team = this.team, store = this.st.cityStore ?? [], cap = storeCap(balance);
    const city = this.st.cities?.[this.st.homeCity];
    add(text(this, x0, y0, `主城 ${city?.name ?? ''}：调动武将（存放 ${store.length}/${cap}）   战力 ${Math.round(computePower(team, balance))}`, 19, '#2ecc71'));
    add(text(this, x0, y0 + 28, '1/2 选副将、3/4/5 选主城里的武将，Enter 执行；Esc 关闭。主角不能存进主城。', 13, '#aaaaaa'));
    const col = (title, x) => add(text(this, x, y0 + 56, title, 15, '#f1c40f'));
    col('队伍（副将）', x0); col('主城存放', x0 + 370);
    const card = (g, x, y, label, sel, onClick) => {
      const r = add(this.add.rectangle(x, y, 340, 50, sel ? 0x3d5a80 : 0x24302a).setOrigin(0).setStrokeStyle(2, sel ? 0xf1c40f : 0x666666));
      r.setInteractive({ useHandCursor: true }).on('pointerdown', (p, lx, ly, ev) => { ev?.stopPropagation?.(); onClick(); });
      add(this.add.rectangle(x + 10, y + 18, 14, 14, tierColor(g)).setOrigin(0));
      add(text(this, x + 30, y + 15, `[${label}] ${generalLine(g)}`, 13));
    };
    const reps = replaceableIndices(team, balance);
    reps.forEach((i, k) => card(team.generals[i], x0, y0 + 84 + k * 60, k + 1, this.selT === i, () => { this.selT = this.selT === i ? null : i; this.msg = ''; this.render(); }));
    for (let k = reps.length; k < balance.team_rules.max_generals - 1; k++) add(text(this, x0 + 12, y0 + 100 + k * 60, '（空位）', 13, '#777777'));
    store.forEach((g, k) => card(g, x0 + 370, y0 + 84 + k * 60, k + 3, this.selS === k, () => { this.selS = this.selS === k ? null : k; this.msg = ''; this.render(); }));
    for (let k = store.length; k < cap; k++) add(text(this, x0 + 382, y0 + 100 + k * 60, '（空位）', 13, '#777777'));
    const by = this.oy + H - 96;
    add(button(this, x0, by, 460, 44, `[Enter] ${this.actionLabel()}`, () => this.execute(), { enabled: this.selT != null || this.selS != null, color: 0x1e6b3a }));
    add(button(this, this.ox + W - 140, by, 116, 44, '[Esc] 关闭', () => this.close()));
    if (this.msg) add(text(this, x0, by + 54, this.msg, 14, '#aaffaa'));
  }
}
