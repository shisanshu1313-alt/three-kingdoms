// 引擎/表现层参数（程序侧）。所有玩法数值（地图尺寸、速度、战力、AI、战斗、刷新、碰撞规则）
// 都来自策划配置 src/data/balance.json，不在这里硬编码。
import balance from './data/balance.json';
export const TILE_SIZE = balance.map.tile_px; // 来自 balance.map（地图格数也在 balance.map）
export const MAP_SEED = 184;          // 地形噪声随机种子（城池/官道位置由 balance 决定）
export const TEAM_SEED = 2026;        // 黄巾头目属性/名字的随机种子

export const PARTY_SIZE = 20;         // 队伍色块边长（像素，与 balance.collision.shape 一致）
export const CLICK_ARRIVE_DIST = 4;   // 路点到达判定距离

export const CAMERA_LERP = 0.1;       // 镜头跟随平滑度
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.5;
export const ZOOM_STEP = 0.1;
export const MINIMAP_SIZE = 200;      // 小地图边长（屏幕像素）

// 寻路/AI 执行层工程参数（不影响数值平衡）
export const CHASE_REPLAN_MS = 500;   // 追击时重算路径间隔
export const FLEE_REPLAN_MS = 1000;   // 逃跑时重算路径间隔
export const FLEE_PROBE_ANGLES_DEG = [0, 30, -30, 60, -60, 90, -90, 135, -135]; // 逃跑方向试探角
export const NEAR_PLAYER_FULL_LABEL_PX = 160; // 离玩家多近显示完整标签
