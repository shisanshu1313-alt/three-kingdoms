# ChatGPT风格战术俯视 topdown_s3e — 试玩接入说明

**日期**：2026-10-30（Asia/Shanghai）  
**状态**：资源已放到旁路目录，**未**覆盖 `parties/atlas/`，**未**改正式 JS 默认，**未** git push / 发版。  
**建议端口**：本地试玩 **`:5221`**（s3d `:5216` / s3c `:5219` / softTau `:5217` 仍可对照）。  
**小维（经 PM）**：s3d 缝/浅弧/清晰度已过，先改骑弓再推；确认前不上线。

## 1. 资源路径（已同步）

| 位置 | 路径 |
|------|------|
| 游戏可 preload | `sanguo-game/public/assets/sprites/parties/atlas_topdown_s3e/{key}.png|.json` |
| 美术旁路 | `sanguo-art/parties/atlas_topdown_s3e/` |
| `_try` 别名 | `sanguo-art/parties/_try/topdown_s3e/` |
| 源草稿 | `sanguo-art/parties/_drafts/topdown_s3e/` |
| keyed | `sanguo-art/parties/_drafts/topdown_s3e/keyed/`（cav/arc 新；inf/spr=s3c） |
| 总览 / XL / 对比 | `_production/troop_silhouette_topdown_s3e_sheet.png`、`..._s3e_xl.png`、`troop_compare_s3d_vs_s3e_cav_arc.png` |
| 说明 | `_drafts/topdown_s3e_notes.md`、本文件 |

**八 key 同前**：`soldier_inf` `soldier_spr` `soldier_arc` `soldier_cav` `officer` `officer_cav` `named_base` `named_cav`

**无旗 / 无环**。**formation.json**：美术侧 **未改**。

## 2. 帧约定

- 八向 idle：`idle_{s|se|e|ne|n|nw|w|sw}_0`
- walk/charge：仅 `walk_s_0..3` / `charge_s_0..3`
- **64×64**，**pivot / origin `(0.5, 0.5)`**
- JSON Hash，`meta.app = sanguo-art-topdown-s3e`
- 图集单页：512×128（8×2 帧）

## 3. 给程序 — 最短接入清单

1. **preload** → `atlas_topdown_s3e`（旁路，不动正式 `atlas/`）。
2. **sprite origin** → `(0.5, 0.5)`。
3. **无 banner / 无 ring**。
4. **堵 melee/bow 旧 atlas 回退**。
5. 建议本地 **`:5221`**；`TRY_SCALE` 建议 **~2.0**（与现 s3d tip 一致）；**未推**线上。
6. 回退：preload 改回 `atlas_topdown_s3d`（`:5216`，TRY_SCALE≈2.0）。

## 4. 与 s3d 差异

| | s3d | s3e |
|--|-----|-----|
| 帧 | 64×64 | **64×64** |
| 源 | s3c keyed 四兵种 | **cav/arc 新 gen+rembg**；inf/spr 同 s3d |
| 骑弓轮廓 | 易糊成暗梭 | **马头/腿/骑手可分；弓弧外伸** |
| 建议 TRY_SCALE | ~2.0 | **~2.0** |
| 建议端口 | :5216/:5220 | **:5221** |

## 5. 风险

- inf/spr 未重画（刻意保留小维已过版本）；若整体色调与新骑弓略有色差属预期。
- walk/charge 仍仅南向占位（微 bob）。
- 引擎若仍按「立牌」绕 Y / 脚底 origin，俯视会被读歪。
- softTau / 固定槽位 depth / 缝隙 F4·L2.8 等程序侧调参 **美术未改**。
- 旁路目录，不影响正式 atlas；**未 git push**。
