// 可复现随机数（mulberry32）。返回 () => [0,1)，附带 getState()/setState(s) 供存档使用
export function mulberry32(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.getState = () => a;
  next.setState = (s) => { a = s >>> 0; };
  return next;
}
/** 一局里某条命名随机数流的初始种子（runSeed + 流名 → 32 位），新流（如 v0.6 的 ai）不打乱已有流的种子顺序；老存档迁移也用它 */
export function streamSeed(runSeed, name) {
  let h = 0x811c9dc5;
  for (const ch of String(name)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return ((runSeed >>> 0) ^ h) >>> 0;
}
export const randRange = (rng, min, max) => min + rng() * (max - min);
export const randInt = (rng, min, max) => Math.floor(randRange(rng, min, max + 1));
