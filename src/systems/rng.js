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
export const randRange = (rng, min, max) => min + rng() * (max - min);
export const randInt = (rng, min, max) => Math.floor(randRange(rng, min, max + 1));
