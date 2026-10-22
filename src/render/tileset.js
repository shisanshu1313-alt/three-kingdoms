import { TERRAIN } from '../world/MapGenerator.js';

/**
 * 表现层：把地形色块绘制成一张 tileset 画布纹理（每种地形一格，加一点像素噪点）。
 * 地图生成（world/MapGenerator.js）是纯逻辑，只产出格子数据；画图都在 render/ 里。
 */
export function createTilesetTexture(scene, key, tileSize) {
  const tex = scene.textures.createCanvas(key, tileSize * TERRAIN.length, tileSize);
  const ctx = tex.getContext();
  TERRAIN.forEach((t, i) => {
    const ox = i * tileSize;
    ctx.fillStyle = t.color;
    ctx.fillRect(ox, 0, tileSize, tileSize);
    // 像素风细节点缀
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    for (let k = 0; k < 6; k++) {
      ctx.fillRect(ox + ((k * 7 + i * 3) % (tileSize - 4)) + 2, ((k * 11 + i * 5) % (tileSize - 4)) + 2, 3, 3);
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.strokeRect(ox + 0.5, 0.5, tileSize - 1, tileSize - 1);
  });
  tex.refresh();
  return tex;
}
