/**
 * 战斗表现层（只画，不改 melee / radiusOf / 战力）：
 * impact/braced → 接触点火花/斩线 + 相机短 shake；
 * 持续接触 → 节流 slash；高 v → 兵脚尘土。
 */
const SHAKE_MS = 100; // 80–120 取中
const SHAKE_INTENSITY = 3.5;
const SLASH_INTERVAL_MS = 220;
const DUST_SPEED = 90; // px/s 以上才扬尘

/** 两队接触中点（缺一方则用已知方） */
export function contactMid(a, b) {
  if (a && b) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const p = a || b;
  return p ? { x: p.x, y: p.y } : null;
}

/**
 * impact / braced 爆发：接触点放射短线 + 小火花点；可选相机 shake。
 * @param {Phaser.Scene} scene
 * @param {{x:number,y:number}} mid
 * @param {'impact'|'braced'} type
 */
export function burstContactFx(scene, mid, type = 'impact') {
  if (!scene || !mid) return;
  const color = type === 'braced' ? 0x66ccff : 0xffee88;
  const n = type === 'braced' ? 6 : 10;
  const g = scene.add.graphics().setDepth(14);
  scene.minimap?.ignore(g);
  for (let i = 0; i < n; i++) {
    const ang = (Math.PI * 2 * i) / n + (Math.random() - 0.5) * 0.4;
    const len = 10 + Math.random() * 16;
    const x2 = mid.x + Math.cos(ang) * len;
    const y2 = mid.y + Math.sin(ang) * len;
    g.lineStyle(2, color, 0.95).lineBetween(mid.x, mid.y, x2, y2);
    g.fillStyle(color, 1).fillCircle(x2, y2, 1.5 + Math.random());
  }
  // 中心斩线
  const a0 = Math.random() * Math.PI;
  g.lineStyle(3, 0xffffff, 0.9).lineBetween(
    mid.x + Math.cos(a0) * 18, mid.y + Math.sin(a0) * 18,
    mid.x - Math.cos(a0) * 18, mid.y - Math.sin(a0) * 18,
  );
  scene.tweens.add({
    targets: g, alpha: 0, duration: 280, onComplete: () => g.destroy(),
  });
  // 相机短 shake（忽略小地图相机）
  const cam = scene.cameras?.main;
  if (cam?.shake) cam.shake(SHAKE_MS, SHAKE_INTENSITY / 1000);
}

/**
 * 持续接触节流 slash：画在两队连线中点附近的短斜线。
 * 返回是否真正画了（供调用方记时间）。
 */
export function maybeContactSlash(scene, a, b, nowMs, lastAt = 0) {
  if (!a || !b || nowMs - lastAt < SLASH_INTERVAL_MS) return false;
  const mid = contactMid(a, b);
  if (!mid) return false;
  const dx = b.x - a.x, dy = b.y - a.y;
  const ang = Math.atan2(dy, dx) + Math.PI / 2;
  const g = scene.add.graphics().setDepth(13);
  scene.minimap?.ignore(g);
  const ox = (Math.random() - 0.5) * 10, oy = (Math.random() - 0.5) * 10;
  const len = 8 + Math.random() * 10;
  g.lineStyle(2, 0xfff0c0, 0.85).lineBetween(
    mid.x + ox - Math.cos(ang) * len, mid.y + oy - Math.sin(ang) * len,
    mid.x + ox + Math.cos(ang) * len, mid.y + oy + Math.sin(ang) * len,
  );
  scene.tweens.add({ targets: g, alpha: 0, duration: 160, onComplete: () => g.destroy() });
  return true;
}

/** 高 v 脚底尘土：在 party 位置后方喷几点 */
export function maybeFootDust(scene, party, body, nowMs, lastAt = 0) {
  if (!party || !body || (body.v ?? 0) < DUST_SPEED) return false;
  if (nowMs - lastAt < 90) return false;
  const h = body.h ?? 0;
  const bx = party.x - Math.cos(h) * 8 + (Math.random() - 0.5) * 6;
  const by = party.y - Math.sin(h) * 8 + (Math.random() - 0.5) * 6;
  const c = scene.add.circle(bx, by, 2 + Math.random() * 2, 0x8a7048, 0.55).setDepth(8);
  scene.minimap?.ignore(c);
  scene.tweens.add({
    targets: c, alpha: 0, scale: 2.2, y: by + 4, duration: 280, onComplete: () => c.destroy(),
  });
  return true;
}

export const combatVfxConsts = { SHAKE_MS, SHAKE_INTENSITY, SLASH_INTERVAL_MS, DUST_SPEED };
