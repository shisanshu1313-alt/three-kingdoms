import { radiusOf, soldiersOf, moraleOf, inCombat } from '../systems/melee.js';
import { UNIT_NAMES } from '../systems/units.js';

/**
 * 队伍表现层（Phaser）：圆（半径 = 战斗半径，随兵数变化）+ 兵种字 + 朝向 + 兵数条 / 士气条 + 标签 + 小地图标记。
 * 逻辑都在 PartyModel / melee 战斗体里；这里只负责画。位置在两次固定 tick 之间插值。
 */
export default class PartyView {
  constructor(scene, model) {
    this.scene = scene;
    this.model = model;
    this.labelMode = null;
    this._rev = model.rev;
    const c = model.color;
    this.radius = 16;
    this.body = scene.add.circle(model.x, model.y, this.radius, c)
      .setStrokeStyle(2, model.isPlayer ? 0xffffff : 0x000000).setDepth(10);
    this.unitText = scene.add.text(model.x, model.y, '', { fontFamily: 'sans-serif', fontSize: '13px', color: '#ffffff', stroke: '#000', strokeThickness: 3, fontStyle: 'bold' })
      .setOrigin(0.5).setDepth(11);
    this.bars = scene.add.graphics().setDepth(11);
    this.label = scene.add.text(0, 0, '', {
      fontFamily: 'sans-serif', fontSize: '12px', color: '#ffffff', align: 'center',
      stroke: '#000000', strokeThickness: 3
    }).setOrigin(0.5, 1).setDepth(11);
    // 小地图标记（主相机不显示），否则色块缩到 1px 看不清
    this.minimapDot = scene.add.rectangle(model.x, model.y, 64, 64, c).setStrokeStyle(model.isPlayer ? 16 : 0, 0xffffff).setDepth(20);
    scene.minimap?.ignore([this.unitText, this.bars]);
    this.setLabelMode(model.isPlayer);
  }

  /** 固定 tick 之前记下位置，用于插值 */
  beforeTick() { this.prev = { x: this.model.x, y: this.model.y }; }

  /** 位置插值 + 半径 / 兵种 / 状态条；模型 refresh() 过（数值变化）就让标签重画 */
  sync(alpha = 1, b = null, now = 0) {
    const m = this.model, p = this.prev ?? { x: m.x, y: m.y };
    const x = p.x + (m.x - p.x) * alpha, y = p.y + (m.y - p.y) * alpha;
    const cfg = this.scene.field?.cfg;
    const r = cfg && b ? radiusOf(soldiersOf(b), cfg) : 16;
    if (Math.abs(r - this.radius) > 0.05) { this.radius = r; this.body.setRadius(r); }
    this.body.setPosition(x, y);
    this.body.setAlpha(m.isInvincible(now) ? 0.45 : 1); // 脱战保护：半透明
    this.unitText.setPosition(x, y).setText(UNIT_NAMES[m.team.unit] ?? '');
    this.minimapDot.setPosition(m.x, m.y);
    const g = this.bars.clear();
    if (b) {
      // 朝向
      const hx = x + Math.cos(b.h) * (r + 5), hy = y + Math.sin(b.h) * (r + 5);
      g.lineStyle(3, 0xffffff, 0.8).lineBetween(x + Math.cos(b.h) * r, y + Math.sin(b.h) * r, hx, hy);
      if (inCombat(b) || b.routed) {
        // 兵数条（当前 / 本场开战时）+ 士气条（溃逃线 morale_rout 处有刻度）
        const W = 40, n = soldiersOf(b), n0 = b.N0start ?? b.N0, mor = Math.max(0, moraleOf(b, cfg));
        const bx = x - W / 2, by = y + r + 4;
        g.fillStyle(0x000000, 0.7).fillRect(bx - 1, by - 1, W + 2, 10);
        g.fillStyle(0x44dd44, 1).fillRect(bx, by, W * Math.max(0, Math.min(1, n / Math.max(1e-9, n0))), 4);
        g.fillStyle(mor < cfg.move.morale_rout ? 0xff4444 : 0xffcc33, 1).fillRect(bx, by + 4, W * Math.min(1, mor / 100), 4);
        g.fillStyle(0xffffff, 1).fillRect(bx + W * cfg.move.morale_rout / 100, by + 4, 1, 4);
        if (b.dis > 0) g.lineStyle(2, 0xffdd55, 0.9).strokeCircle(x, y, r + 2); // 冲散
      }
    }
    if (this._rev !== m.rev) { this._rev = m.rev; this.labelMode = null; this.setLabelMode(this._wantFull ?? m.isPlayer); }
  }

  /** 标签：简略（名字+兵）/ 完整（加武将、战力） */
  setLabelMode(full) {
    this._wantFull = full;
    const mode = full ? 'full' : 'compact';
    if (mode === this.labelMode) return;
    this.labelMode = mode;
    const m = this.model, t = m.team;
    if (full) {
      const gens = t.generals.map(g => g.name).join('·');
      this.label.setText(`${t.name}\n${gens}\n兵${t.soldiers}/${m.cap} 战${Math.round(m.power)}`);
    } else {
      this.label.setText(`${t.name} ${t.soldiers}`);
    }
  }

  /** 战斗中标签：名字 + 实时兵数 */
  setBattleLabel(shown) {
    const txt = `⚔ ${this.model.team.name} 兵${shown}`;
    if (this.label.text !== txt) this.label.setText(txt);
    this.labelMode = 'battle';
  }

  destroy() { this.body.destroy(); this.label.destroy(); this.minimapDot.destroy(); this.unitText.destroy(); this.bars.destroy(); }
}
