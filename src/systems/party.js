import { PARTY_SIZE, CLICK_ARRIVE_DIST } from '../config.js';
import { computePower, soldierCap, teamSpeed } from './combat.js';

/** '#rrggbb' / '#rgb' → 0xrrggbb（与 Phaser HexStringToColor 结果相同） */
export function hexToInt(hex) {
  let h = String(hex).replace(/^#|^0x/i, '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 队伍逻辑模型（纯 JS，不依赖 Phaser / DOM）：包着纯数据 team 对象（结构 = balance.team_example），
 * 位置就是 team.position。AI / 战斗 / 碰撞 / 存档都只读写它；画面由 entities/PartyView.js 每帧同步。
 *
 * world 参数需要提供：clock.now、speedAt(x,y)、isPassable(x,y)（见 systems/world.js 的 WorldModel）。
 * 移动：move(dx,dy) 直接方向移动；setPath(points) + followPath() 沿 A* 路径移动。
 */
export default class PartyModel {
  constructor(team, balance, color = '#ffffff') {
    this.team = team;
    this.balance = balance;
    this.size = PARTY_SIZE;
    this.color = hexToInt(color);
    this.path = null;          // [{x,y}] 世界坐标路点
    this.inBattle = null;      // 当前战斗对象
    this.invincibleUntil = 0;  // 玩家战败后无敌截止（游戏时间 ms）
    this.stuckTime = 0;
    this.rev = 0;              // refresh() 次数：表现层据此知道标签要重画
    this.refresh();
  }

  get id() { return this.team.id; }
  get name() { return this.team.name; }
  get faction() { return this.team.faction; }
  get isPlayer() { return this.team.is_player; }
  get soldiers() { return this.team.soldiers; }
  get x() { return this.team.position.x; }
  get y() { return this.team.position.y; }
  isInvincible(now) { return this.invincibleUntil > now; }

  /** 实际移动速度（未含地形）：配置速度 × 战败逃跑加速（无敌期间） */
  moveSpeed(now) {
    const esc = this.isInvincible(now) ? this.balance.battle.player_defeat.escape_speed_mult : 1;
    return this.speed * esc;
  }

  /** 队伍数值变化后调用：重算战力/上限/速度 */
  refresh() {
    this.power = computePower(this.team, this.balance);
    this.cap = soldierCap(this.team, this.balance);
    this.speed = teamSpeed(this.team, this.balance);
    this.rev++;
  }

  setPosition(x, y) { this.team.position.x = x; this.team.position.y = y; }

  getBounds() {
    const h = this.size / 2;
    return { left: this.x - h, right: this.x + h, top: this.y - h, bottom: this.y + h };
  }

  /** 按方向 (dx,dy)（长度≤1）移动 dt 秒；分轴移动可贴边滑动。返回是否被阻挡 */
  move(dx, dy, dt, world) {
    if (!dx && !dy) return false;
    const speed = this.moveSpeed(world.clock.now) * world.speedAt(this.x, this.y);
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
    const speed = this.moveSpeed(world.clock.now) * world.speedAt(this.x, this.y);
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

  /** 色块放在 (x,y) 时四角是否都可通行 */
  _fits(x, y, world) {
    const h = this.size / 2 - 1;
    return world.isPassable(x - h, y - h) && world.isPassable(x + h, y - h) &&
           world.isPassable(x - h, y + h) && world.isPassable(x + h, y + h);
  }
}
