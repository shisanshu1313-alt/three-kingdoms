/**
 * 队伍可见精灵槽位（纯函数，无 Phaser）：把兵力压进有限精灵预算，供 PartyView 画装饰精灵。
 * 策划 display_slots 终稿：generalCount = clamp(len(generals),1,3)；soldier_budget = 8 - generalCount
 * （空副将位不占预算）；士兵 W=[1,10,100,500]，超预算先 10 合 1，否则整档抬升；≥1 兵且全 0 → t0=1。
 * 不改碰撞 / 战力 / 真实兵力（HUD 仍显示精确兵数）。
 */

export const SOLDIER_WEIGHTS = Object.freeze([1, 10, 100, 500]);
export const TOTAL_SPRITE_SOFT_CAP = 8;

/** generalCount = clamp(len(generals), 1, 3)；空数组也按 1（主角/统帅必有） */
export function generalCountOf(generals) {
  const n = Array.isArray(generals) ? generals.length : 0;
  return Math.max(1, Math.min(3, n || 1));
}

/**
 * @param {number} soldiers 真实兵力（HUD / 逻辑仍用这个数）
 * @param {unknown[]} [generals]
 * @returns {{ t0:number, t1:number, t2:number, t3:number, lead:1, deputies:0|1|2, empty_deputy_slot:0|1, generalCount:number, soldier_budget:number }}
 */
export function displaySlots(soldiers, generals = []) {
  const generalCount = generalCountOf(generals);
  const lead = 1;
  const deputies = /** @type {0|1|2} */ (generalCount - 1);
  const empty_deputy_slot = /** @type {0|1} */ (deputies === 1 ? 1 : 0);
  const soldier_budget = TOTAL_SPRITE_SOFT_CAP - generalCount;

  const n = Math.max(0, Math.floor(Number(soldiers) || 0));
  let t0 = n, t1 = 0, t2 = 0, t3 = 0;

  const sum = () => t0 + t1 + t2 + t3;
  // 超预算：优先 10→1 合成，否则整档抬到上一档（略夸张）
  let guard = 0;
  while (sum() > soldier_budget && guard++ < 1e4) {
    if (t0 >= 10) { t0 -= 10; t1 += 1; continue; }
    if (t1 >= 10) { t1 -= 10; t2 += 1; continue; }
    if (t2 >= 10) { t2 -= 10; t3 += 1; continue; }
    if (t0 > 0) { t0 = 0; t1 += 1; continue; }
    if (t1 > 0) { t1 = 0; t2 += 1; continue; }
    if (t2 > 0) { t2 = 0; t3 += 1; continue; }
    // 只剩 t3 仍超预算：再合成也无处可去，截断到预算（极端大军）
    t3 = soldier_budget;
    break;
  }

  if (n >= 1 && sum() === 0) t0 = 1;

  return { t0, t1, t2, t3, lead, deputies, empty_deputy_slot, generalCount, soldier_budget };
}

/** 展开为士兵档位列表（高档在前），长度 = t0+t1+t2+t3 */
export function soldierTierList(slots) {
  const out = [];
  for (let i = 0; i < (slots.t3 || 0); i++) out.push(3);
  for (let i = 0; i < (slots.t2 || 0); i++) out.push(2);
  for (let i = 0; i < (slots.t1 || 0); i++) out.push(1);
  for (let i = 0; i < (slots.t0 || 0); i++) out.push(0);
  return out;
}
