import { radiusOf, soldiersOf, moraleOf, inCombat } from '../systems/melee.js';
import { UNIT_NAMES } from '../systems/units.js';
import { partyAssetsReady, PartyDecor } from '../render/partySprites.js';

/**
 * 队伍表现层（Phaser）：逻辑圆（半径 = 战斗半径，碰撞不变）+ 像素编队装饰精灵 + 兵种字 + 朝向 + 兵数条 / 士气条 + 标签 + 小地图标记。
 * 逻辑都在 PartyModel / melee 战斗体里；这里只负责画。位置在两次固定 tick 之间插值。
 * HUD / 标签仍显示精确兵数；display_slots 只决定装饰精灵数量。
 */
export default class PartyView {
  constructor(scene, model) {
    this.scene = scene;
    this.model = model;
    this.labelMode = null;
    this._rev = model.rev;
    const c = model.color;
    this.radius = 16;
    // 逻辑体：半透明圆，保留相机跟随 / 碰撞半径可视化；装饰精灵叠在上面
    this.body = scene.add.circle(model.x, model.y, this.radius, c, 0.18)
      .setStrokeStyle(2, model.isPlayer ? 0xffffff : 0x000000, 0.55).setDepth(9);
    this.unitText = scene.add.text(model.x, model.y, '', { fontFamily: 'sans-serif', fontSize: '13px', color: '#ffffff', stroke: '#000', strokeThickness: 3, fontStyle: 'bold' })
      .setOrigin(0.5).setDepth(11);
    this.bars = scene.add.graphics().setDepth(11);
    this.label = scene.add.text(0, 0, '', {
      fontFamily: 'sans-serif', fontSize: '12px', color: '#ffffff', align: 'center',
      stroke: '#000000', strokeThickness: 3
    }).setOrigin(0.5, 1).setDepth(12);
    // 小地图标记（主相机不显示），否则色块缩到 1px 看不清
    this.minimapDot = scene.add.rectangle(model.x, model.y, 64, 64, c).setStrokeStyle(model.isPlayer ? 16 : 0, 0xffffff).setDepth(20);
    scene.minimap?.ignore([this.unitText, this.bars]);
    this.decor = partyAssetsReady(scene) ? new PartyDecor(scene, model) : null;
    if (this.decor) this.unitText.setVisible(false); // 有像素编队时兵种字让给精灵
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
    const inv = m.isInvincible(now);
    this.body.setAlpha(inv ? 0.25 : 0.18);
    this.unitText.setPosition(x, y).setText(this.scout && !this.scout.showUnit ? '' : (UNIT_NAMES[m.team.unit] ?? ''));
    this.minimapDot.setPosition(m.x, m.y);
    const g = this.bars.clear();
    const h = b?.h ?? this._h ?? 0;
    this._h = h;
    if (b) {
      // 朝向（细线；有编队精灵时减弱）
      const hx = x + Math.cos(b.h) * (r + 5), hy = y + Math.sin(b.h) * (r + 5);
      g.lineStyle(2, 0xffffff, this.decor ? 0.35 : 0.8).lineBetween(x + Math.cos(b.h) * r, y + Math.sin(b.h) * r, hx, hy);
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
    if (this.decor) {
      if (this._rev !== m.rev) this.decor.invalidate();
      const moving = !!(b && b.v > 8);
      const shown = (b && (inCombat(b) || b.routed) && this._battleShown != null)
        ? this._battleShown
        : undefined;
      this.decor.sync(x, y, h, moving, shown != null ? { soldiers: shown } : {});
      this.decor.setAlpha(inv ? 0.45 : 1);
    }
    if (this._rev !== m.rev) { this._rev = m.rev; this.labelMode = null; this.setLabelMode(this._wantFull ?? m.isPlayer); }
  }

  /** v0.5 侦察信息（systems/scouting.js）：决定显示兵种 / 兵数精度 / 箭头；玩家自己为 null */
  setScout(info) {
    const key = info ? `${info.tier}|${info.soldiers}|${info.arrow}` : '';
    if (key === this._scoutKey) return;
    this._scoutKey = key; this.scout = info; this.labelMode = null;
  }

  /** 标签：简略（名字+兵）/ 完整（加武将、战力；只在视野内）——兵数永远是精确值，不走 display_slots */
  setLabelMode(full) {
    this._wantFull = full;
    const sc = this.scout;
    if (sc && sc.tier !== 'vision') full = false;
    const mode = full ? 'full' : 'compact';
    if (mode === this.labelMode) return;
    this.labelMode = mode;
    const m = this.model, t = m.team;
    if (full) {
      const gens = t.generals.map(g => g.name).join('·');
      this.label.setText(`${t.name}${sc?.arrow ?? ''}\n${gens}\n兵${t.soldiers}/${m.cap} 战${Math.round(m.power)}`);
    } else if (sc?.tier === 'far') {
      this.label.setText(t.name);
    } else {
      this.label.setText(`${t.name} ${sc ? sc.soldiers : t.soldiers}${sc?.arrow ?? ''}`);
    }
  }

  /** 战斗中标签：名字 + 实时兵数（精确） */
  setBattleLabel(shown) {
    const txt = `⚔ ${this.model.team.name} 兵${shown}`;
    if (this.label.text !== txt) this.label.setText(txt);
    this.labelMode = 'battle';
    this._battleShown = shown;
    if (this.decor) this.decor.invalidate();
  }

  destroy() {
    this.decor?.destroy();
    this.body.destroy(); this.label.destroy(); this.minimapDot.destroy(); this.unitText.destroy(); this.bars.destroy();
  }
}
