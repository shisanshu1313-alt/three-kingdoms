import Phaser from 'phaser';
import { PARTY_SIZE, CLICK_ARRIVE_DIST } from '../config.js';
import { computePower, soldierCap, teamSpeed } from '../systems/combat.js';

/**
 * 队伍实体：Phaser 表现（色块 + 标签）包着纯数据 team 对象（结构 = balance.team_example）。
 * 战斗/存档等系统只读写 team。
 * 移动：move(dx,dy) 直接方向移动；setPath(points) + followPath() 沿 A* 路径移动。
 */
export default class Party {
  constructor(scene, team, balance, color) {
    this.scene = scene;
    this.team = team;
    this.balance = balance;
    this.size = PARTY_SIZE;
    this.path = null;          // [{x,y}] 世界坐标路点
    this.inBattle = null;      // 当前战斗对象
    this.invincibleUntil = 0;  // 玩家战败后无敌截止（ms）
    this.stuckTime = 0;
    this.labelMode = null;

    const c = Phaser.Display.Color.HexStringToColor(color).color;
    this.color = c;
    this.body = scene.add.rectangle(team.position.x, team.position.y, this.size, this.size, c)
      .setStrokeStyle(2, team.is_player ? 0xffffff : 0x000000).setDepth(10);
    this.label = scene.add.text(0, 0, '', {
      fontFamily: 'sans-serif', fontSize: '12px', color: '#ffffff', align: 'center',
      stroke: '#000000', strokeThickness: 3
    }).setOrigin(0.5, 1).setDepth(11);
    this.refresh();
    this.setPosition(team.position.x, team.position.y);
  }

  get id() { return this.team.id; }
  get name() { return this.team.name; }
  get faction() { return this.team.faction; }
  get isPlayer() { return this.team.is_player; }
  get soldiers() { return this.team.soldiers; }
  get x() { return this.body.x; }
  get y() { return this.body.y; }
  isInvincible(now) { return this.invincibleUntil > now; }

  /** 实际移动速度（未含地形）：配置速度 × 战败逃跑加速（无敌期间） */
  moveSpeed() {
    const esc = this.isInvincible(this.scene.clock.now) ? this.balance.battle.player_defeat.escape_speed_mult : 1;
    return this.speed * esc;
  }

  /** 队伍数值变化后调用：重算战力/上限/速度并刷新标签 */
  refresh() {
    this.power = computePower(this.team, this.balance);
    this.cap = soldierCap(this.team, this.balance);
    this.speed = teamSpeed(this.team, this.balance);
    this.labelMode = null;
    this.setLabelMode(this._wantFull ?? this.isPlayer);
  }

  /** 标签：简略（名字+兵）/ 完整（加武将、战力） */
  setLabelMode(full) {
    this._wantFull = full;
    const mode = full ? 'full' : 'compact';
    if (mode === this.labelMode) return;
    this.labelMode = mode;
    const t = this.team;
    if (full) {
      const gens = t.generals.map(g => g.name).join('·');
      this.label.setText(`${t.name}\n${gens}\n兵${t.soldiers}/${this.cap} 战${Math.round(this.power)}`);
    } else {
      this.label.setText(`${t.name} ${t.soldiers}`);
    }
  }

  /** 战斗中标签：名字 + 正在播放的兵数 */
  setBattleLabel(shown) {
    const txt = `⚔ ${this.team.name} 兵${shown}`;
    if (this.label.text !== txt) this.label.setText(txt);
    this.labelMode = 'battle';
  }

  setPosition(x, y) {
    this.body.setPosition(x, y);
    this.team.position.x = x; this.team.position.y = y;
  }

  getBounds() {
    const h = this.size / 2;
    return { left: this.x - h, right: this.x + h, top: this.y - h, bottom: this.y + h };
  }

  /** 按方向 (dx,dy)（长度≤1）移动 dt 秒；分轴移动可贴边滑动。返回是否被阻挡 */
  move(dx, dy, dt, world) {
    if (!dx && !dy) return false;
    const speed = this.moveSpeed() * world.speedAt(this.x, this.y);
    const stepX = dx * speed * dt, stepY = dy * speed * dt;
    let blocked = false;
    let nx = this.x, ny = this.y;
    if (stepX && this._fits(nx + stepX, ny, world)) nx += stepX; else if (stepX) blocked = true;
    if (stepY && this._fits(nx, ny + stepY, world)) ny += stepY; else if (stepY) blocked = true;
    this.setPosition(nx, ny);
    return blocked;
  }

  /** 朝某点直线走一步；返回 'arrived' | 'moving' | 'stuck' */
  stepToward(tx, ty, dt, world) {
    const ddx = tx - this.x, ddy = ty - this.y;
    const d = Math.hypot(ddx, ddy);
    if (d <= CLICK_ARRIVE_DIST) return 'arrived';
    const speed = this.moveSpeed() * world.speedAt(this.x, this.y);
    const k = Math.min(1, d / Math.max(1e-6, speed * dt));
    const ox = this.x, oy = this.y;
    this.move((ddx / d) * k, (ddy / d) * k, dt, world);
    if (Math.abs(this.x - ox) < 0.01 && Math.abs(this.y - oy) < 0.01) {
      this.stuckTime += dt;
      return this.stuckTime > 0.4 ? 'stuck' : 'moving';
    }
    this.stuckTime = 0;
    return 'moving';
  }

  setPath(points) { this.path = points && points.length ? points : null; this.stuckTime = 0; }
  clearPath() { this.path = null; }

  /** 沿路径移动；返回 'none' | 'moving' | 'arrived' | 'stuck' */
  followPath(dt, world) {
    if (!this.path) return 'none';
    const wp = this.path[0];
    const r = this.stepToward(wp.x, wp.y, dt, world);
    if (r === 'arrived') {
      this.path.shift();
      if (!this.path.length) { this.path = null; return 'arrived'; }
      return 'moving';
    }
    if (r === 'stuck') { this.path = null; return 'stuck'; }
    return 'moving';
  }

  _fits(x, y, world) {
    const h = this.size / 2 - 1;
    return world.isPassable(x - h, y - h) && world.isPassable(x + h, y - h) &&
           world.isPassable(x - h, y + h) && world.isPassable(x + h, y + h);
  }

  destroy() {
    this.body.destroy(); this.label.destroy();
    if (this.minimapDot) this.minimapDot.destroy();
  }
}
