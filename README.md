# 三国·群雄逐鹿（像素风开放世界原型）— M3「能变强」+ 存档（数值对齐 balance v0.4）

单人、实时、俯视角三国开放世界原型。引擎 **Phaser 3**（npm 依赖），构建 **Vite**，美术为**色块占位**。

## v0.6：四选一抽卡 + 名册 + 主城 / 攻城（分支 `proto/v0.6`，未合入 main）

数值全部来自策划定稿 `/workspace/design/balance_v0.6.json`（19 项决定全部按推荐）：`npm run sync:v06`（`scripts/sync-v06.mjs`）→ `src/data/v06.json`；测试只读 `tests/fixtures/` 里的副本（不读 /workspace/design/）。程序侧【假设】在 `src/data/assumptions.json` 的 `v06`（values 是游戏读取的开关 / 数值，notes 是说明）。

**怎么玩**：`npm install && npm run dev -- --port 5182`（worktree `/workspace/sanguo-game-v06`）→ http://localhost:5182/ 。开局出生在洛阳城外（洛阳有黄巾守军）。
- 移动 / 战斗同 v0.5：WASD/方向键、左键寻路、滚轮缩放；没有撤退键，把队伍开走就是脱离。C 属性详情、P 暂停、F1 调试视野。
- **无接触结束**（`battle.no_contact_end_s` = 4，策划 2026-10-23）：交战双方连续 4 s 没接触、谁也没在追、谁也没在放箭 → 这一场以「脱离接触，各自收兵」（separated）结束；之后同 apart：这一对 10 s 内不再开打，没有保护。计时在纯函数 `melee.step` 的 pairs 里，随存档保存。读定稿 `battle_v06.no_contact_end_s` / `no_contact_chase_frac`（4 / 0.5，已写入定稿）。
- **抽卡 G**：空格 付费（50 + 5n 点，封顶 150）→ 出 4 张（普通 / 稀有 / 史诗）→ 按 1–4 或点卡片选一张（必须选，Esc 关不掉，刷新页面回到同一组）；F 换一批（每章第 1 次免费，之后收点数；每抽最多换 1 次）。卡面写效果和战力变化。物品栏满 → 选丢哪件；兵种令 → 选兵种。
- **名册**（队伍满 3 人时得到新武将）：E 替换 → 按数字选换下谁 → R 流放（+20 点）/ H 送回主城存放；也可直接流放 / 存放新武将。
- **主城**：攻洛阳（扣城防 → 消灭守军 → 在城心待 5 s）后立为主城。主城 200 px 内按 H：1/2 选副将、3–5 选存放的武将（最多 3 个）、Enter 存入 / 取出 / 对调。主城 / 无守军的无主城里回血、征兵、B 整编。占第二座城时问是否迁都（Y / N）；迁都后旧主城变无主城，同样可以回血 / 征兵 / 整编。
- **攻城**：城防按章 230 / 420 / 700 / 870；攻城方接触城圆扣城防，城上弓箭射所有接触城圆、且与城主敌对的队伍（友军 / 同盟路过不射）；守军和坐镇大本营的名将永不撤退，第 3 章名将出城后按普通 AI 撤退；城防归零后 20 s 内（且 8 s 没挨打）不回复，之后每秒回 3%。第 2 章起在主城里连续待 20 s（第 1 章的时间不算，进第 2 章从 0 开始；出城清零）→ 最近的未讨伐势力派兵（黄巾不派；或刷 0.8–1.2 倍讨伐军）来攻；第 3 章起离开主城 > 500 px 每分钟 20% 被趁虚攻打；城破后敌人在城心待 10 s → 主城失守（变回无主城，城防 30%，存放的武将流散）。
- **调参 tuning_r1**（策划 2026-10-23 已定，`balance_v0.6.json` 的 `tuning_r1.proposals`，tag = decided 才生效 → `v06.tuning`）：
  - T1 攻城：每秒城防伤害 ≤ 该章城防上限 / `siege_min_s`（15）→ 任何攻城满城防打到 0 至少 15 s（第 1–4 章每秒最多 15.3 / 28 / 46.7 / 58）。多队一起攻共用上限。
  - T2 刷新：场上已满 10 队时，每次刷新检查（12 s）撤下 1 支战力 < 0.6 × 玩家、不在交战、距玩家 > 400 px 的普通黄巾队（不含来袭 / 守军 / 攻城队 / 名将军 / 校尉军；多支取最弱、同战力按 id），腾位按当前章节重刷（`teams.pickStaleTeam`）。
  - T3 黄巾 `flee_ratio` = 0.4（其他势力仍按性格 0.6 / 0.8 / 1.0）。名将军逃跑留到下一轮，没动。
  - T4 洛阳守军战力 = max(`garrison_power_floor` 70, 0.5 × 玩家战力)（开局约 64 → 70）；城名下方标签显示「守军战力 N」，玩家战力低于守军 → 标签变红并写「强于你」（`city.cityLabel`）。
  - T5（野外收拢）/ T6（逃脱给点数）：用户否决（rejected），没做、不进配置。
- **主城被攻 / 趁虚攻打不派黄巾**：`city_v06.raid_exclude` = ["黄巾"]（按势力名或 id），20 s 派兵和第 3 章趁虚攻打都用它。
- 统率（L）：主角统率 + 副将 × 0.3，影响速度（封顶 100）；HUD 显示「统率项 L」。副将擅长当前兵种 +0.05、敌队统帅擅长 +0.10。

**测试**：`npm test` 291 个（含 `gacha_v06` / `roster` / `city_v06` / `leader_v06` / `battle_v06` / `v06_config`：定稿 ↔ 配置逐项对照）。浏览器冒烟（`PW_PATH=<playwright-core>`，开发服务器 5182）：`node tests/smoke-v06.cjs`（24 项：抽卡 4 选 1 / 换一批 / 必须选 → 名册替换 + 流放 / 存城 → 攻洛阳 → 占城 → 城防回复 / 城内保护 → H 互换 → AI 讨伐军攻城 → 失守 → 存档 v6 读档 / 洛阳标签显示守军战力；`SHOTS=/workspace` 写 `v06-gacha.png` / `v06-city.png` / `v06-run.png`），以及 `smoke.cjs` / `smoke-v05.cjs` / `smoke-run.cjs` / `smoke-hud.cjs` / `smoke-dist.cjs`（正式构建，`vite preview --port 4174`）全部通过。

**可复现（确定性）**：同一 runSeed → 同一结果。所有游戏随机数都走 runSeed 派生的种子流（team / gacha / combat / spawn / ai，`rng.streamSeed`）；v0.6 起 AI 游荡 / 发呆也用 `rngs.ai`（以前是 `Math.random`），存档 v6 保存 `rng.ai`（v5 → v6 迁移按 `streamSeed(runSeed, 'ai')` 补）。逻辑只由固定 0.1 s tick 推进。纯逻辑模块里没有 `Math.random` / `Date.now` 默认值了（`tests/determinism_v06.test.js` 在模拟时把 `Math.random` 换成抛错）。开发构建下 `window.__SANGUO_SIM = { seed, manualTick: true }` 固定 runSeed 并停掉实时推进（只由 `debugAdvance` 推进）；正式构建忽略它。

**20 分钟无界面模拟**：`npm run sim:v06 -- http://localhost:5182/`（`tools/sim-v06.cjs`；`SEEDS=1,2,3 STRAT=rush|farm|active STALL_S=6 OUT=结果.json`；`REPEAT=2` 或 `npm run sim:v06:check` 每个种子跑两遍逐字节比较，不同 → 打印差异字段、退出码 1；`TUNING=off` 关掉 tuning_r1 T1–T4 跑基线）。在 headless Chrome 里跑真实逻辑（manualTick + 固定 tick 快进）。脚本玩家：rush 直接攻洛阳 / farm 先打弱队、兵 ≥ 35 再攻 / active（移植自策划 `tuning_r1/sg06/tools/sim-r1.cjs`：只打估算比 ≥ 1.1 的、躲 ≥ 1.0 的、残血回城、会用兵种令、绕开打不过的名将军）。脚本玩家无接触 STALL_S 秒还没被 separated 规则解开才自己走开，记为「僵持」（stallInfo 记原因）。结果另记 separated 次数、撤下过弱队次数、本局 tuning。

**已知问题 / 待策划确认**：见 `assumptions.json` 的 `v06.notes`；没做卡面「对视野内敌人的胜算预览」。

## v0.5 正式版：roguelike 一局 + 移动接触式实时战斗（分支 `proto/v0.5-combat`，未合入 main）

数值全部来自策划定稿 `/workspace/design/balance_v0.5.json`：`npm run sync:v05`（`scripts/sync-v05.mjs`）→ `src/data/combat_v05.json`（实时战斗）+ `src/data/run_v05.json`（一局的规则）。配置里只有文字的规则在 sync 里转成数值，注释标【解读】。

**怎么玩**：`npm install && npm run dev -- --port 5180`（worktree `/workspace/sanguo-game-v05`）→ http://localhost:5180/ 。标题页「开始新的一局」（有进行中的一局时可「继续」）。
- WASD/方向键 开队伍、左键点地面 寻路、滚轮 缩放、悬停队伍 看详情；G 抽卡、B 城中整编（换兵种）、C 属性详情、P 暂停 / 放弃本局；F1 调试视野。
- **没有撤退键**：想跑就把队伍开走，间隙 > 150 px 保持 2 s 算脱离，逃脱方 8 s 保护（背对敌人时挨打 ×1.3）。

**已做完（v0.5 全部条目）**
- 一局约 20 分钟，4 章（0 / 4 / 9 / 14 分钟）：黄巾之乱、群雄并起、诸侯割据、天下三分；刷新战力区间和克制倍率（1.0 / 1.1 / 1.25 / 1.45）按章节走。
- 地图 1600 px、五城；最多 10 支 AI，每 12 s 刷一支（400–800 px 外）。开局 20 s 黄巾来袭（0.6–0.8 倍，350–450 px，直冲玩家）；前 90 s 其他 AI 不追玩家。
- 第 3 / 4 章的黄巾有 35% / 50% 带克制玩家 **60 s 前**兵种的兵（换兵种后有 60 s 空窗）；第 1 章 70% 步兵，第 2 章四种均匀。
- 实时接触战斗（`systems/melee.js` 纯函数 `step`）：接触掉兵、弓兵射程 120 / 弹药 12 s、冲锋与枪兵反冲、背击 ×1.3、士气 < 30 溃逃（一场最多一次，下一场士气回满）、第三方中途加入（= 合并成一队）、AI 追 3 s 放弃、不追弱 3 倍以上的队伍。
- 兵种：一队一种，枪 > 骑 > 弓 > 步 > 枪；主将擅长兵种 +0.10；克制物品（拒马 / 藤甲 / 重铠）和斥候旗。
- 成长：抽卡价 **min(30 + 3n, 90)**，卡池 属性小 44 / 属性大 13 / 物品 22 / 兵种令 10 / 操练 5 / A 将 5 / S 将 1（B 将 0，概率表不显示）。城中整编 30 点（5 s 不能动）。侦察：300 px 内看清兵种、兵数、强弱色、克制箭头；300–500 px 只看兵种和约数。黄巾头目不可俘获。
- 名将军（曹操 / 关羽 / 周瑜 / 吕布）1–2 章坐镇，3 章起领地 420 px 内追击；不在交战中每累计 60 s +3 兵（不超过上限；交战中计时暂停，战后不补算，计时随存档保存）。某势力没被讨伐、场上又没有它的队伍时，下一次刷新改为在大本营出一支「校尉军」（统武 60–80、智魅 40–70、战力 max(120, 玩家) × U(0.8, 1.2)、势力兵种）。只有名将军被其他 AI 打掉（不是玩家打的）之后，玩家击败该势力的校尉军才算讨伐该势力。
- 失败（规则 B）：兵力 0 或主角 HP 0。HP 100，打输按阵亡比例扣（35 × 阵亡 / 战前）、溃逃 −20、撤退失败 −5；城外每分钟 +10、城内（200 px）每秒 +2，战斗中和脱战 5 s 内不回。兵 < 40 时待在城里每 2 s +1 兵。失败 → 删档 → 写局外数据 → 结算画面 → 再来一局。
- 胜利：讨伐 4 路名将军（玩家要有伤害份额）→ 胜利画面。
- 局外成长只解锁（`sanguo-meta-v1`）：开局枪兵（进入第 2 章，即第 4 分钟）、弓兵（击败周瑜军）、骑兵（击败吕布军）、开局带廖化（名望 300）、开局物品可选良马 / 兵书 / 招降旗（名望 600）、群雄模式（首次通关；刷新 +0.1、克制 +0.05）。名望 = 存活分钟 × 2 + 名将 × 50 + 最高战力 / 10。
- 存档：只有一个自动存档 `sanguo-run-v1`（每 30 s、换章、战斗前后、弹窗关闭；交战中每 1 s 存战斗快照，读档原样继续，有 3 s 倒计时）；死亡或通关删档；旧版 `sanguo-save`（v3）启动时改名为 `sanguo-save-legacy` 并提示。全部走 `platform/storage`。
- 输入全部经过 `platform/input.js`；同一个原生键盘事件只派发一次（Phaser 3.90 一帧内会重复派发，导致 F1 切两次、空格抽两次）。

**测试**：`npm test`（node:test，243 个，含 `tests/statsView.test.js`：HUD 属性面板的派生值与变化检测；含 `tests/run_v05.test.js`：策划定稿清单 ↔ 配置逐项对照、抽卡价、针对兵种、补兵、校尉军、讨伐、失败 / 胜利 / 名望 / 解锁 / 删档；`tests/combat_v05.test.js`：实时战斗）。浏览器（需 playwright-core + Chrome，开发服务器 5180）：`node tests/smoke-run.cjs`（新局 → 20 s 来袭 → 补兵 / 校尉军 → HP 0 失败 → 删档 → 再来一局 → 整编 → 暂停 → 刷新继续；截图 `/workspace/v05-run-screenshot.png`）、`node tests/smoke-v05.cjs`（接触 → 战斗中刷新读档 → 开走脱离）、`node tests/smoke.cjs http://localhost:5180/`（v0.4 玩法回归）、`node tests/smoke-dist.cjs <正式构建 URL>`（黑盒）、`node tests/smoke-hud.cjs [URL]`（HUD 属性：小面板 → C 详情 → 属性卡 / 得到武将刷新高亮 → 点按钮收起 → 竖屏 390×844；截图 `/workspace/hud-stats-screenshot.png`、`/workspace/hud-stats-portrait.png`）。

**策划已确认（2026-10-22）**：名将军被其他 AI 打掉后击败该势力校尉军算讨伐（`faction_refill.counts_when_named_lost`，只在这种情况下）；名将军补兵交战中暂停、战后不补算（`named_reinforce.pause_in_battle` / `catch_up`）；开局枪兵 = 进入第 2 章。三条都由 `npm run sync:v05` 从配置读取。目前没有待确认的【假设】。

- 已知问题（策划 open_tuning）：战力 0.9–1.0 倍时弓兵风筝步兵胜负波动大；多队混战没有专门模拟。

## 运行

```bash
npm install            # 需要 Node >= 20.10（package.json engines）
npm run dev            # 开发服务器 http://localhost:5173/
npm run build          # 产出 dist/（正式构建：没有调试钩子、没有 F2）
npm run preview        # 预览 dist/
npm run build:smoke    # 产出 dist-smoke/：同正式构建，但带 window.__game / __balance（给冒烟测试用）
npm run preview:smoke  # 预览 dist-smoke/（端口 4175）
npm test               # 单测：公式 / worked_examples / A* / AI 决策 / 战斗结算 / 抽卡 / 名册 / 存档 / 输入 / 纯 Node 加载
npm run sync:balance   # 从 ../design/balance_v0.4.json 同步策划配置
node tests/smoke.cjs http://localhost:5173/        # 完整冒烟（开发服务器或 dist-smoke；需 playwright-core + Chrome；截图写到 artifacts/，不进仓库）
node tests/smoke-dist.cjs http://localhost:4174/   # 黑盒冒烟（正式 dist：确认没有调试钩子，只看键盘 + 存档内容）
```

**调试钩子**（`src/debug.js`）：`window.__game`、`window.__balance` 只在 `npm run dev` 和 `build:smoke`（`.env.smoke` 里 `VITE_DEBUG_HOOKS=1`）里有；正式 `dist/` 里被常量折叠删除（`grep __game dist/assets/*.js` 为空），F2 调试加点同理。

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
| 右上属性小面板（常显） | 统帅（= 主角，永远是统帅）姓名与统率 / 武力 / 智力 / 魅力；统率最高的武将不是主角时多一行「战力/速度按 X 统率 N」（现有结算按统率最高者算，见下） |
| C / 「属性 [C]」按钮 / 点小面板 | 展开 / 收起属性详情（不暂停游戏；点详情面板也能收起）：统帅 / 副将的四维（武将 n/3）、兵力上限、战力倍率、智力减伤、总损兵减免、魅力收编率、统率速度、行军速度、擅长兵种。抽卡属性卡、得到 / 替换武将、换兵种等变化时实时刷新，变化的数值高亮约 1.5 s。横屏在右侧，竖屏 / 窄屏贴底、字号更小 |
| G / 右上「抽卡 [G]」按钮 | 打开抽卡（大地图暂停）；战斗中或有待安排武将时不能抽（后者会先弹出名册窗口） |
| 抽卡界面 | 空格 或 点「抽一次」；抽取动画任意键/点击跳过；结果先展示，需要选择时按 Enter/Esc 或点「确定」进入选择；1~3 选武将（属性）或丢弃旧物品；0/R 放弃新物品 |
| 抽卡 Esc（v0.4 esc_rule） | 待机：关闭界面；抽取动画：跳过；结果：确认（回待机或进入选择）；选武将 / 物品栏满 / 队伍满：忽略（抽卡已扣点，必须选） |
| 名册窗口（满编） | 1/2 或 点按钮 替换对应随从；R 或 点按钮 释放新武将（+20 点）；必须当场选择，不能关闭 |
| F5 / F9 | 手动存档 / 读档（带提示；战斗中也能存，读档后战斗按原结果继续；抽卡/名册窗口打开时先关窗口） |
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
- `screen.js`：屏幕尺寸。网页 = `window.innerWidth/innerHeight` + Phaser RESIZE（与以前相同）；小游戏换 `WxScreenAdapter(wx | tt)`（getSystemInfoSync）。入口 `main.js` 只通过 `scaleConfig()` 取尺寸。
- `input.js`：输入动作层。场景只监听动作（`move` 向量、`moveTo` 点地面、`confirm`/`cancel`/`primary`/`choose N`/`release`/`yes`/`no`、`openGacha`、`toggleStats`（C）、`save`/`load`、`debugVision`/`debugPoints`、`zoom`、`tap`、`any`），不碰原始按键。现在有 `KeyboardSource`（键位与以前完全一样，见 `DEFAULT_BINDINGS`）和 `PointerSource`（鼠标/触屏点按、滚轮）；触摸摇杆以后实现 `{ moveVector(), attach(emit), detach() }` 再 `actions.addSource()` 即可。
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
tests/  combat / worked_examples / battle / aiBrain / pathfinder / gacha / roster / save / reload / gameClock / input / screen / pureLogic（node:test）+ smoke.cjs（完整）/ smoke-dist.cjs（黑盒，正式构建）
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
