# 三国·群雄逐鹿（像素风开放世界原型）— M3「能变强」+ 存档（数值对齐 balance v0.4）

单人、实时、俯视角三国开放世界原型。引擎 **Phaser 3**（npm 依赖），构建 **Vite**，美术为**色块占位**。

## 运行

```bash
npm install
npm run dev            # 开发服务器 http://localhost:5173/
npm run build          # 产出 dist/
npm run preview        # 预览 dist/
npm test               # 单测：公式 / worked_examples / A* / AI 决策 / 战斗结算 / 抽卡 / 名册
npm run sync:balance   # 从 ../design/balance_v0.4.json 同步策划配置
node tests/smoke.cjs http://localhost:5173/   # 无头浏览器冒烟（需 playwright-core + Chrome）
```

## 策划配置（balance.json）

- 源文件：`/workspace/design/balance_v0.4.json`（策划维护）；游戏读副本 `src/data/balance.json`。
- 策划改完后执行 `npm run sync:balance`；换版本（v0.4…）时改 `package.json` 的 `sync:balance` 和 `tests/combat.test.js` 第一条用例里的文件名。该用例会检查副本与原件一致。
- **所有玩法数值都从 balance.json 读取**：地图尺寸、城池、地形速度/可通行、阵营 home/颜色/性格、初始队伍、战力/速度/兵力上限/损兵减免、战斗结算与取整、积分/收编/俘获、取整规则、主将规则、AI 状态机（含 chase_max_ratio）、补充刷新、碰撞规则、抽卡（价格/权重/属性/物品/武将/文案）、抽卡界面（gacha_ui）、满编替换/释放（roster）。
- `src/data/assumptions.json`：v0.4 仍未明确、程序先按“假设”实现的点（见下；目前只剩表现层）。

## 操作

| 操作 | 说明 |
|---|---|
| WASD / 方向键 | 8 方向移动（取消点击路径）；战斗中不可操作（纯数值结算） |
| 鼠标左键 | A* 寻路移动到点击处（绕开山/水，偏好官道、避开森林） |
| 鼠标悬停队伍 | 显示完整信息（武将、兵/上限、战力）；靠近玩家的队伍也自动显示 |
| 滚轮 | 缩放 0.5x ~ 2.5x |
| G / 右上「抽卡 [G]」按钮 | 打开抽卡（大地图暂停）；战斗中或有待安排武将时不能抽（后者会先弹出名册窗口） |
| 抽卡界面 | 空格 或 点「抽一次」；抽取动画任意键/点击跳过；结果先展示，需要选择时按 Enter/Esc 或点「确定」进入选择；1~3 选武将（属性）或丢弃旧物品；0/R 放弃新物品 |
| 抽卡 Esc（v0.4 esc_rule） | 待机：关闭界面；抽取动画：跳过；结果：确认（回待机或进入选择）；选武将 / 物品栏满 / 队伍满：忽略（抽卡已扣点，必须选） |
| 名册窗口（满编） | 1/2 或 点按钮 替换对应随从；R 或 点按钮 释放新武将（+20 点）；必须当场选择，不能关闭 |
| F5 / F9 | 手动存档 / 读档（带提示；战斗中按 F5 会在战斗结束后自动存） |
| 标题菜单（有存档时） | Enter/1 或点「继续游戏」；N/2 或点「新游戏」→ 确认 Y / 取消 N（会删除存档）；存档损坏时只显示原因和「新游戏」 |
| F2 | 调试：点数 +200（**只在 `npm run dev` 开发模式**，生产构建里没有这个按键） |
| F1 | 调试：视野圈（vision_px）、游荡范围、所有路径（红=追击 蓝=逃跑 白=回家/游荡 黄=玩家） |

## 玩法（M2 + M3 已实现）

- **AI 状态机**（`systems/aiBrain.js` 纯函数 + `systems/ai.js` 执行）：每 `tick_s` 扫描视野；`r = 我方面板战力/对方` → `r ≤ flee_ratio` 逃（优先）/ `r ≥ chase_ratio` 追；追击超 `chase_give_up_px` 或 `chase_max_s` 放弃并忽略 `ignore_target_s`；逃到 `flee_safe_px` 或 `flee_max_s` 后回家；离家 > `wander_radius_px × return_home_radius_mult` 进入 return。不打同阵营、战斗中队伍、无敌玩家。
- **A\* 寻路**（`world/Pathfinder.js`）：8 方向、禁止切角、代价 = 距离/地形速度、LRU 缓存、节点上限；路径拉直；追击每 500ms、逃跑每 1s 重算。
- **战斗**（`systems/combat.js` 公式 + `systems/battle.js` 应用）：碰撞 → 双方冻结 T 秒（标签上兵数线性下降、红圈⚔标记）→ 一次性结算：损兵、收编、逐将掷俘获、积分（只有玩家胜利得分）、AI 败方解散（名将回自由池）、平局双方各推开 `draw_pushback_px` 并冷却 `draw_pair_cooldown_s`、战后保护 `post_battle_grace_s`、同时撞多队只打最近的一队。
- **取整（v0.3 numeric_rules）**：中间量保持浮点；损兵/阵亡/积分 `floor(x+0.5+1e-9)`；收编/残部保留 `floor(x+1e-9)`。主将 = 统率最高（并列取靠前）。本场俘获不提高本场兵力上限。
- **玩家战败**：保留 `max(5, floor(溃兵×0.5))`，主角不被俘、随从可被俘；无敌 `invincible_s` 秒、速度 ×`escape_speed_mult`（战后保护取 max(1s grace, 8s 无敌)）。兵数为 0 的 AI 队伍按败方移除；玩家兵数最低补到 5。
- **AI 追击上限**：`r ≥ ai.chase_max_ratio`（3）时不主动追（碰上照常开战）。
- **抽卡（M3，v0.4）**：`systems/gacha.js`（纯逻辑）+ `scenes/GachaScene.js`。单价 `min(50+5×已抽, 200)`，点击即扣点并计次；6 档权重；无保底。属性卡加 `pool[].attr_amount`（+2 / +5）；武将只从自由池对应档位（`pool[].tier`）等概率出，档位空了按 `gacha.empty_tier_fallback` 改出；属性在未满项中随机、截断到 100，全队全满返还 25；物品从整张 items 表等概率抽（`item_source = items_all_uniform`，含已拥有，重复返还 25），满栏选择丢旧或放弃（返还 25）。v0.3 的重叠字段（`gacha.overlap_note`）不再读取。
- **满编替换/释放（M3）**：`systems/roster.js` + `scenes/RosterScene.js`。俘获或抽到武将而队伍已满 3 将 → `pendingGenerals` 先进先出逐个弹窗：替换随从（主角不可替换；名将回自由池、头目消失）或释放（+20 点，俘获和抽卡来源都给）。替换后战力/上限/速度即时重算；若主将会变化，窗口里会提示。
- **补充刷新**：每 `respawn_interval_s` 若 AI 队伍 < `max_ai_teams`，在距玩家 700~1400px、视野外的可通行格刷黄巾，战力 ≈ 玩家 × U(0.5,1.3)；黄巾头目名不放回抽取。
- **UI**：点数（下一抽价格）、兵力/上限、战力、武将、待安排武将、自由池数量、状态（交战/无敌倒计时）、最近 5 条战报、战斗提示。
- **标签防重叠**：默认简略标签，靠近玩家/悬停显示完整；重叠的标签自动向上堆叠。

## 游戏时钟（core/GameClock.js，v0.4 pause_scope）

所有计时都走游戏时钟 `world.clock.now`，不用真实时间：战斗时长、战后保护、玩家无敌、平局冷却、AI 状态计时与忽略名单、补充刷新、自动存档间隔。时钟只在大地图 `update` 里按帧间隔推进（单帧最多 250ms）；打开抽卡/名册窗口时大地图暂停，时钟和全部计时一起冻结（单测 `tests/gameClock.test.js`，冒烟测试也会检查）。

## 平台适配（src/platform/，为以后 iOS / 微信 / 抖音小游戏准备）

- `storage.js`：存储接口 `get / set / remove`。现在用 `LocalStorageAdapter`（localStorage 不可用时退回内存）；小游戏换 `WxStorageAdapter(wx | tt)`。**除这里以外不许直接用 localStorage。**
- `lifecycle.js`：`onHide(cb)`。网页 = visibilitychange / pagehide / beforeunload；小游戏换 `WxLifecycleAdapter`（wx.onHide）。
- `input.js`：输入动作层。场景只监听动作（`move` 向量、`moveTo` 点地面、`confirm`/`cancel`/`primary`/`choose N`/`release`/`yes`/`no`、`openGacha`、`save`/`load`、`debugVision`/`debugPoints`、`zoom`、`tap`、`any`），不碰原始按键。现在有 `KeyboardSource`（键位与以前完全一样，见 `DEFAULT_BINDINGS`）和 `PointerSource`（鼠标/触屏点按、滚轮）；触摸摇杆以后实现 `{ moveVector(), attach(emit), detach() }` 再 `actions.addSource()` 即可。
- `systems/save.js` 是纯逻辑，存储由调用方传入（单测用 `MemoryStorageAdapter`）。

## 存档（systems/save.js）

- **存储**：平台存储接口（见上）键 `sanguo-save`，JSON，带 `saveVersion`（当前 3）、`balanceVersion`、`mapSeed`、`savedAt`。
- **内容**：玩家队（位置、兵数、武将、物品、主将）、点数、抽卡次数、自由池、待安排武将队列、抽卡后未完成的选择（`gachaPending`）、俘获记录、战报、全部 AI 队（位置、兵数、武将、AI 状态/目标/忽略名单、home）、**进行中的战斗**（结果开战时已掷好）、补充刷新计数与定时器、黄巾头目名字池使用情况、随机数流（队伍/名字、**抽卡、战斗结算**）、平局冷却、无敌/战后保护、游戏时钟、镜头缩放。所有截止时间都是游戏时钟上的绝对时刻。
- **武将只存 id + 成长值**（v3）：名将和主角存 `{ id, growth: { 属性: 成长 } }`，读档时基础属性取当前配置再加成长（截到 0~attr_cap），策划改数值会生效；黄巾头目没有配置，存完整属性。
- **什么时候存**（存档决定 1）：每次开战前、打开抽卡/名册窗口前、抽卡结果产生后（扣点+出结果是原子的）、每做完一个选择后、战斗结束后、每 30 秒游戏时间（`SAVE_INTERVAL_S`）、页面隐藏/关闭时、F5。任何时刻都可以存。
- **不能重掷**（存档决定 3）：抽卡和战斗结算用存档里的种子随机数流（`rngs.gacha` / `rngs.combat`），读档后结果与不读档完全相同。AI 游荡和补充刷新仍用不保存的随机数。
- **未完成的选择**：抽卡后的选武将 / 物品栏满、满编的替换/释放，读档后自动重新弹出对应窗口，抽卡不回滚。
- **读档容错**：JSON 损坏、字段缺失/非法、引用了不存在的武将/物品 → corrupt；存档版本比游戏新 → too_new；地图种子不同或缺迁移 → incompatible。都只显示原因并提供新游戏，不会崩溃。数值版本不同但数据有效 → 可以继续，并提示一次（存档决定 2）。
- **迁移**：`MIGRATIONS[v]` 把 v 版升级到 v+1，读档时逐级执行：v1→v2（剩余时长 → 游戏时钟绝对时刻）、v2→v3（完整属性 → 成长值 = 存档属性 − 当前配置基础值，负数按 0）。

## 文件结构

逻辑和表现分开（平台规则 1）：`systems/ core/ world/ data/ platform/` 是纯 JS，不 import Phaser、不碰 DOM，`tests/pureLogic.test.js` 在纯 Node 里加载全部模块（import 'phaser' 会直接报错）并跑一段 AI + 碰撞 + 战斗 + 存档的模拟。`scenes/ entities/ render/ ui/` 是 Phaser 表现层。

```
src/
  main.js / config.js            入口；引擎/表现层参数（相机、标签、寻路重算间隔等，非数值）
  core/EventBus.js               纯 JS 事件总线：party-collision / party-sighted / ai-state / battle-start / battle-end / party-spawned / party-removed
  core/GameClock.js              游戏时钟 + 定时器（暂停即冻结，可存档）
  data/
    balance.json                 策划配置副本（勿手改）
    assumptions.json             仍未明确的【假设】项
    terrain.json / display.json  地形颜色/中文名；兜底颜色
    index.js                     加载配置、构建初始队伍、黄巾名字分配
  world/  MapGenerator.js（纯：格子数据，城池/官道按 balance.cities）  Pathfinder.js（A*）
  systems/                       —— 纯逻辑 ——
    world.js     WorldModel：地形查询、点击寻路 / pathTo、出生与补充刷新落点、平局推开；snapshotWorld 存档快照
    party.js     PartyModel：队伍逻辑（team 数据 + 位置 + 路径跟随 + 战力/速度缓存）
    combat.js    纯函数：战力/上限/速度/减免/俘获率/resolveCombat
    battle.js    applyBattleResult（纯函数）+ BattleSystem（开战/结算/存档序列化）
    aiBrain.js   AI 决策纯函数     ai.js  AI 执行（寻路、逃跑选点、视野事件）
    collision.js AABB 碰撞 + 事件去抖（engine_debounce_ms）
    teams.js     队伍构建、命名规则、补充刷新兵数反解
    gameState.js 积分/自由池/待处理俘虏/战报
    gacha.js     抽卡纯逻辑（价格/权重/武将/属性/物品/文案）
    roster.js    满编队列、替换/释放
    save.js      存档：结构/校验/迁移/读写（存储由调用方传入）
    rng.js       可存档的种子随机数
  platform/storage.js / lifecycle.js / input.js / screen.js  平台接口：存储、切后台/关闭、输入动作、屏幕尺寸
  render/tileset.js              表现：地形 tileset 纹理
  entities/PartyView.js          表现：队伍色块/标签/小地图点，每帧从 PartyModel 同步
  scenes/ BootScene / TitleScene / WorldScene / UIScene / GachaScene / RosterScene
  ui/widgets.js                  按钮/文字/档位颜色等占位 UI 组件
tests/  combat / worked_examples / battle / aiBrain / pathfinder / gacha / roster / save / reload / gameClock / input / pureLogic（node:test）+ smoke.cjs
```

## 已决定（PM / 用户确认 2026-10-22，balance decisions）

- 名将被击败且未被俘：回自由池，只能靠抽卡获得（`named_after_defeat`）。
- AI 败方物品：消失（`loser_items`）。

## 仍是【假设】的点（assumptions.json）

v0.3/v0.4 已回答之前全部战斗/抽卡/名册假设（v0.4 补了属性卡数值、空档改出、Esc 规则、暂停范围）。剩下：
1. 抽卡动画样式：配置只给了 `roll_anim_s`=1 和可跳过；实现为结果卡在 6 档颜色间闪烁。

## 部署到 GitHub Pages

目标地址：https://shisanshu1313-alt.github.io/three-kingdoms/

1. 在 GitHub 创建仓库 `shisanshu1313-alt/three-kingdoms`，把本目录推到 `main` 分支。
2. 仓库 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**。
3. 之后每次 push 到 `main`（或在 Actions 页手动 Run workflow）会执行 `.github/workflows/deploy.yml`：
   `npm ci` → `npm test`（单测不过不部署）→ `npm run build` → 上传 `dist/` → 部署。
4. `vite.config.js` 使用 `base: './'`（全部相对路径），所以仓库改名/换子路径也无需改配置。

本地模拟 Pages 子路径：
```bash
npm run build
mkdir -p /tmp/pages/three-kingdoms && cp -r dist/. /tmp/pages/three-kingdoms/
cd /tmp/pages && python3 -m http.server 8090   # 打开 http://localhost:8090/three-kingdoms/
```

注：`tests/combat.test.js` 的“副本与策划原件一致”用例需要 `../design/balance_v0.4.json`，在独立仓库/CI 中会自动跳过。

## 下一步

像素美术、音效。
