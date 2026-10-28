# 三国·群雄逐鹿（像素风开放世界原型）— v0.6：四选一抽卡 + 名册 + 主城 / 攻城（数值对齐 balance v0.6）

单人、实时、俯视角三国开放世界原型。引擎 **Phaser 3**（npm 依赖），构建 **Vite**，美术为**色块占位**。

## v0.6：四选一抽卡 + 名册 + 主城 / 攻城（分支 `proto/v0.6`，未合入 main）

数值全部来自策划定稿 `/workspace/design/balance_v0.6.json`（19 项决定全部按推荐）：`npm run sync:v06`（`scripts/sync-v06.mjs`）→ `src/data/v06.json`；测试只读 `tests/fixtures/` 里的副本（不读 /workspace/design/）。程序侧【假设】在 `src/data/assumptions.json` 的 `v06`（values 是游戏读取的开关 / 数值，notes 是说明）。

**怎么玩**：`npm install && npm run dev -- --port 5182`（worktree `/workspace/sanguo-game-v06`）→ http://localhost:5182/ 。开局出生在洛阳城外（洛阳有黄巾守军）。
- 完整按键表见下面「操作（v0.6）」，玩法见「玩法（v0.6）」，存档见「存档（v6）」。开发模式下 F2 打开调试菜单（加点、立即主城 / 迁都、填满队伍触发 T2、给一名武将、下一抽必出武将卡、最近的城城防归零），F1 切换调试视野；这两个正式版都没有。
- **无接触结束**（`battle.no_contact_end_s` = 4，策划 2026-10-23）：交战双方连续 4 s 没接触、谁也没在追、谁也没在放箭 → 这一场以「脱离接触，各自收兵」（separated）结束；之后同 apart：这一对 10 s 内不再开打，没有保护。计时在纯函数 `melee.step` 的 pairs 里，随存档保存。读定稿 `battle_v06.no_contact_end_s` / `no_contact_chase_frac`（4 / 0.5，已写入定稿）。
- **抽卡 G**：空格 付费（50 + 5n 点，封顶 150）→ 出 4 张（普通 / 稀有 / 史诗）→ 按 1–4 或点卡片选一张（必须选，Esc 关不掉，刷新页面回到同一组）；F 换一批（每章第 1 次免费，之后收点数；每抽最多换 1 次）。卡面写效果和战力变化。物品栏满 → 选丢哪件；兵种令 → 选兵种。
- **名册**（队伍满 3 人时得到新武将）：E 替换 → 按数字选换下谁 → R 流放（+20 点）/ H 送回主城存放；也可直接流放 / 存放新武将。
- **主城**：攻洛阳（扣城防 → 消灭守军 → 在城心待 5 s）后立为主城。主城 200 px 内按 H：1/2 选副将、3–5 选存放的武将（最多 3 个）、Enter 存入 / 取出 / 对调。主城 / 无守军的无主城里回血、征兵、B 整编。占第二座城时问是否迁都（Y / N）；迁都后旧主城变无主城，同样可以回血 / 征兵 / 整编。
- **攻城**：城防按章 230 / 420 / 700 / 870；攻城方接触城圆扣城防，城上弓箭射所有接触城圆、且与城主敌对的队伍（友军 / 同盟路过不射）；守军和坐镇大本营的名将永不撤退，第 3 章名将出城后按普通 AI 撤退；城防归零后，攻城方还贴着城、或玩家还在和守军交战 → 回复倒计时暂停（不重置，离开后接着计）；离开累计满 20 s（且 8 s 没挨打）才每秒回 3%，回复后要重新破城（`city_v06.siege.regen_rule`）。换章：每秒伤害上限立即按新章；满城防的城抬到新章上限，不满的当前值不变（`siege.chapter_change`）。第 2 章起在主城里连续待 20 s（第 1 章的时间不算，进第 2 章从 0 开始；出城清零）→ 最近的未讨伐势力派兵（黄巾不派；或刷 0.8–1.2 倍讨伐军）来攻；第 3 章起离开主城 > 500 px 每分钟 20% 被趁虚攻打；城破后敌人在城心待 10 s → 主城失守（变回无主城，城防 30%，存放的武将流散）。
- **调参 tuning_r1**（策划 2026-10-23 已定，`balance_v0.6.json` 的 `tuning_r1.proposals`，tag = decided 才生效 → `v06.tuning`）：
  - T1 攻城：每秒城防伤害 ≤ 该章城防上限 / `siege_min_s`（15）→ 任何攻城满城防打到 0 至少 15 s（第 1–4 章每秒最多 15.3 / 28 / 46.7 / 58）。多队一起攻共用上限。
  - T2 刷新：场上已满 10 队时，每次刷新检查（12 s）撤下 1 支战力 < 0.6 × 玩家、不在交战、距玩家 > 400 px 的普通黄巾队（不含来袭 / 守军 / 攻城队 / 名将军 / 校尉军；多支取最弱、同战力按 id），腾位按当前章节重刷（`teams.pickStaleTeam`）。
  - T3 黄巾 `flee_ratio` = 0.4（≤ 0.4 就逃，等于也逃；其他势力仍按性格 0.6 / 0.8 / 1.0）。只管「看见就逃」，交战中的撤退不变（士气 < 30 溃逃），有单测锁定。名将军逃跑留到下一轮，没动。
  - T4 洛阳守军战力 = max(`garrison_power_floor` 70, 0.5 × 玩家战力)，**在玩家开始和守军交战时重算**（`city_v06.garrison.power_recalc`，策划 2026-10-23 定稿；规则见下面「玩法」）；城名下方「守军战力 N」标签，标签战力严格大于玩家战力（按显示的整数，相等不提示）→ 红字「强于你」（`city.cityLabel`，`power_recalc.stronger_hint`）。
  - T5（野外收拢）/ T6（逃脱给点数）：用户否决（rejected），没做、不进配置。
- **调参 tuning_r2**（`balance_v0.6.json` 的 `tuning_r2` → `v06.tuning`）：N2 / N3 第 3 / 4 章黄巾刷新战力 [0.6,1.0] / [0.7,1.1]（`chapter_spawn_power`）；N1 是模拟脚本追击（`tools/sim-v06.cjs`，不进游戏）；**U1 = B（用户 2026-10-23 定）：开局第一次来袭 20 s → 50 s**（`first_battle_at_s`，从 `decisions.U1.rule` 读，`firstBattleAtS()` 覆盖 `run_v05.first_battle.at_s`）。U2 = A 不改；**U3 = C（策划定 22）：抽卡 `gacha_v06.pools.rare.general_A` 12 → 22**，其他权重不变（同步时按 `decisions.U3.value` 覆盖进 `v06.gacha.pools`，`v06.tuning.gacha_pool_weights` 记 from → to；`TUNING=off` 不还原这一项）。`TUNING=off` 开关说明：不含 U3-C 和 U1-B（策划 2026-10-23；当前实现里 U3-C 不还原，`first_battle_at_s` 被置 null → 来袭回到 20 s）。
- **主城被攻 / 趁虚攻打不派黄巾**：`city_v06.raid_exclude` = ["黄巾"]（按势力名或 id），20 s 派兵和第 3 章趁虚攻打都用它。
- 统率（L）：主角统率 + 副将 × 0.3，影响速度（封顶 100）；HUD 显示「统率项 L」。副将擅长当前兵种 +0.05、敌队统帅擅长 +0.10。

**测试**：`npm test` 369 个（含 `gacha_v06` / `roster` / `city_v06` / `city_edge_v06`（强于你 / 换章 / 城防回复三条边界规则、守军第三方加入、正式构建去日志 / 去 F1） / `leader_v06` / `battle_v06` / `v06_config`：定稿 ↔ 配置逐项对照）。浏览器冒烟（`PW_PATH=<playwright-core>`，开发服务器 5182）：`node tests/smoke-v06.cjs`（26 项：抽卡 4 选 1 / 换一批 / 必须选 → 名册替换 + 流放 / 存城 → 攻洛阳 → 占城 → 城防回复 / 城内保护 → H 互换 → AI 讨伐军攻城 → 失守 → 存档 v6 读档 / 洛阳标签显示守军战力 / 开战时重算守军；`SHOTS=/workspace` 写 `v06-gacha.png` / `v06-city.png` / `v06-run.png`），`node tests/smoke-debug.cjs`（20 项，开发服务器：F2 调试菜单 → 点数 / 立即主城 / 迁都 Y / 填满队伍触发 T2 / 没有副将按 E 提示「还没有武将」/ 4 给武将 ×2 入队、满编弹名册 → 流放 / 5 下一抽必出武将卡 / 6 最近的城城防归零、不交战、窗口内不回复），`node tests/smoke-portrait.cjs`（15 项：竖屏 380 / 390 宽抽卡面板在屏内），`node tests/smoke-resize.cjs`（13 项：重开 ×3 / 结算→再来一局后 resize 监听数不变、抽卡面板开着时转屏重新布局、放弃本局后的标题页 resize 后仍居中），`node tests/smoke-title.cjs`（19 项：第一次打开 →「开始」→ has_started_run 写入 → 没存档再打开是正常版；「操作说明 [H]」键盘 / 鼠标 / 触屏开关；旧档迁移；380 / 360 宽面板在屏内），以及 `smoke.cjs` / `smoke-v05.cjs` / `smoke-run.cjs` / `smoke-hud.cjs` / `smoke-dist.cjs`（正式构建，`vite preview --port 4174`）全部通过。

**可复现（确定性）**：同一 runSeed → 同一结果。所有游戏随机数都走 runSeed 派生的种子流（team / gacha / combat / spawn / ai，`rng.streamSeed`）；v0.6 起 AI 游荡 / 发呆也用 `rngs.ai`（以前是 `Math.random`），存档 v6 保存 `rng.ai`（v5 → v6 迁移按 `streamSeed(runSeed, 'ai')` 补）。逻辑只由固定 0.1 s tick 推进。纯逻辑模块里没有 `Math.random` / `Date.now` 默认值了（`tests/determinism_v06.test.js` 在模拟时把 `Math.random` 换成抛错）。开发构建下 `window.__SANGUO_SIM = { seed, manualTick: true }` 固定 runSeed 并停掉实时推进（只由 `debugAdvance` 推进）；正式构建忽略它。

**20 分钟无界面模拟**：`npm run sim:v06 -- http://localhost:5182/`（`tools/sim-v06.cjs`；默认种子 1–48（策划 S1：正式模拟三种策略都跑 1–48，`SEEDS=1-24` / `SEEDS=1,2,3` 可改）；`STRAT=rush|farm|active STALL_S=6 OUT=结果.json`；`REPEAT=2` 或 `npm run sim:v06:check` 每个种子跑两遍逐字节比较，不同 → 打印差异字段、退出码 1；`TUNING=off` 关掉 tuning_r1 T1–T4 跑基线，不含 U3-C 和 U1-B）。在 headless Chrome 里跑真实逻辑（manualTick + 固定 tick 快进）。脚本玩家：rush 直接攻洛阳 / farm 先打弱队、兵 ≥ 35 再攻 / active（移植自策划 `tuning_r1/sg06/tools/sim-r1.cjs`：只打估算比 ≥ 1.1 的、躲 ≥ 1.0 的、残血回城、会用兵种令、绕开打不过的名将军）。脚本玩家无接触 STALL_S 秒还没被 separated 规则解开才自己走开，记为「僵持」（stallInfo 记原因）。结果另记 separated 次数、撤下过弱队次数、本局 tuning。

**已知问题 / 待策划确认**：见 `assumptions.json` 的 `v06.notes`；没做卡面「对视野内敌人的胜算预览」。

## v0.5 正式版：roguelike 一局 + 移动接触式实时战斗（分支 `proto/v0.5-combat`，未合入 main）

数值全部来自策划定稿 `/workspace/design/balance_v0.5.json`：`npm run sync:v05`（`scripts/sync-v05.mjs`）→ `src/data/combat_v05.json`（实时战斗）+ `src/data/run_v05.json`（一局的规则）。配置里只有文字的规则在 sync 里转成数值，注释标【解读】。

**怎么玩**：`npm install && npm run dev -- --port 5180`（worktree `/workspace/sanguo-game-v05`）→ http://localhost:5180/ 。标题页「开始新的一局」（有进行中的一局时可「继续」）。
- WASD/方向键 开队伍、左键点地面 寻路、滚轮 缩放、悬停队伍 看详情；G 抽卡、B 城中整编（换兵种）、C 属性详情、P 暂停 / 放弃本局；F1 调试视野（仅开发 / build:smoke）。
- **没有撤退键**：想跑就把队伍开走，间隙 > 150 px 保持 2 s 算脱离，逃脱方 8 s 保护（背对敌人时挨打 ×1.3）。

**已做完（v0.5 全部条目）**
- 一局约 20 分钟，4 章（0 / 4 / 9 / 14 分钟）：黄巾之乱、群雄并起、诸侯割据、天下三分；刷新战力区间和克制倍率（1.0 / 1.1 / 1.25 / 1.45）按章节走。
- 地图 1600 px、五城；最多 10 支 AI，每 12 s 刷一支（400–800 px 外）。开局 20 s 黄巾来袭（v0.5 分支；v0.6 起改为 50 s，见上面 tuning_r2 U1-B）（0.6–0.8 倍，350–450 px，直冲玩家）；前 90 s 其他 AI 不追玩家。
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

- 标题页（BootScene → TitleScene，QA-10 / 策划定）：**每次打开都先到标题页**。第一次打开（没有进行中的一局、没有局外解锁）只显示「开始 [Enter]」按钮和一行操作说明（Enter / 点按按钮都开始，竖屏约 380 宽放得下）；有存档时照旧（继续 / 放弃本局），有局外解锁时显示新一局选项。**点过「开始」进过一局就不再是第一次打开**（策划 2026-10-23：局外数据 meta 里存 `has_started_run = true`，走存储接口；哪怕没解锁、中途放弃也算）：之后标题页是正常版（没有操作说明那行），底部有小入口「操作说明 [H]」打开说明面板（H / 点按打开，Esc / Enter / H / 点「关闭」/ 点面板外关闭；竖屏 ~380 宽放得下）。旧档迁移：meta 没有这个字段时，`runs > 0` / 有解锁 / 存储里已有任何存档（进行中的一局、坏档、已归档旧档）都算 true 并写回。


```bash
npm install            # 需要 Node >= 20.10（package.json engines）
npm run dev            # 开发服务器 http://localhost:5173/
npm run build          # 产出 dist/（正式构建：没有调试钩子、没有 F1 调试视野 / F2 调试菜单 / F5/F9；游戏的 console.log / debug / info 被去掉，warn / error 保留）
npm run preview        # 预览 dist/
npm run build:smoke    # 产出 dist-smoke/：同正式构建，但带 window.__game / __balance（给冒烟测试用）
npm run preview:smoke  # 预览 dist-smoke/（端口 4175）
npm test               # 单测：公式 / worked_examples / A* / AI 决策 / 战斗结算 / 抽卡 / 名册 / 存档 / 输入 / 纯 Node 加载
npm run sync:balance   # 从 ../design/balance_v0.4.json 同步基础配置
npm run sync:v05       # 从 ../design/balance_v0.5.json 同步 v0.5（实时战斗 / 一局）
npm run sync:v06       # 从 ../design/balance_v0.6.json 同步 v0.6 → src/data/v06.json（再手动复制到 tests/fixtures/ 给单测）
npm run sim:v06        # 20 分钟无界面模拟（见上）
node tests/smoke.cjs http://localhost:5173/        # 完整冒烟（开发服务器或 dist-smoke；需 playwright-core + Chrome；截图写到 artifacts/，不进仓库）
node tests/smoke-dist.cjs http://localhost:4174/   # 黑盒冒烟（正式 dist：确认没有调试钩子，只看键盘 + 存档内容）
node tests/smoke-resize.cjs http://localhost:5182/ # resize / 重开：监听不累积、抽卡面板转屏重排、标题居中
node tests/smoke-title.cjs http://localhost:5182/  # 标题页：has_started_run、「操作说明」入口（键盘 / 鼠标 / 触屏、竖屏）
```

**调试钩子**（`src/debug.js`）：`window.__game`、`window.__balance` 只在 `npm run dev` 和 `build:smoke`（`.env.smoke` 里 `VITE_DEBUG_HOOKS=1`）里有；正式 `dist/` 里被常量折叠删除（`grep __game dist/assets/*.js` 为空）。**F2 调试菜单（开发专用）**：`UIScene` 在 `if (import.meta.env.DEV)` 里动态 `import('../ui/DebugMenu.js')`（它再引用 `systems/devTools.js`），正式构建里整段连同两个模块被删掉、也不产出单独的 chunk；`grep -r "调试菜单\|DebugMenu\|devTools\|【调试】" dist/` 为空（`tests/devtools.test.js` 检查只能动态加载，`smoke-dist.cjs` 检查 F2 → 1 / 2 在正式版里无效）。

## 策划配置（balance.json）

- 源文件：`/workspace/design/balance_v0.4.json`（策划维护）；游戏读副本 `src/data/balance.json`。
- 策划改完后执行 `npm run sync:balance`；换版本（v0.4…）时改 `package.json` 的 `sync:balance` 和 `tests/combat.test.js` 第一条用例里的文件名。该用例会检查副本与原件一致。
- **所有玩法数值都从 balance.json 读取**：地图尺寸、城池、地形速度/可通行、阵营 home/颜色/性格、初始队伍、战力/速度/兵力上限/损兵减免、战斗结算与取整、积分/收编/俘获、取整规则、主将规则、AI 状态机（含 chase_max_ratio）、补充刷新、碰撞规则、抽卡（价格/权重/属性/物品/武将/文案）、抽卡界面（gacha_ui）、满编替换/释放（roster）。
- `src/data/assumptions.json`：v0.4 仍未明确、程序先按“假设”实现的点（见下；目前只剩表现层）。

## 操作（v0.6）

所有按键都经过 `platform/input.js` 的动作层（`DEFAULT_BINDINGS`），场景只听动作；鼠标 / 触屏点按钮和按键等价。

**标题 / 结算**
| 按键 | 说明 |
|---|---|
| Enter / 1 | 有进行中的一局：继续（存档时正在交战 → 暂停，倒计时 3 s 继续战斗） |
| N / 2 → Y / N | 新的一局：先确认放弃当前这局（Y 放弃，按失败结算、名望照常计入；N 取消） |
| 第一次打开 Enter / 点「开始」 | 开始新的一局（标题页只有「开始」+ 一行操作说明） |
| 标题页（正常版）H / 点「操作说明」 | 打开操作说明面板（Esc / Enter / H / 点「关闭」/ 点面板外关闭） |
| 新一局面板 1 / 2 / 3 / 4 · Enter | 切换开局兵种 / 开局武将 / 开局物品 / 群雄模式（需已解锁）；Enter 开始 |
| 结算画面 Enter / Esc | 再来一局 / 回标题 |

**大地图**
| 按键 | 说明 |
|---|---|
| WASD / 方向键 | 8 方向移动（取消点击路径）。**没有撤退键**：把队伍开走就是脱离 |
| 鼠标左键 | A* 寻路到点击处 |
| 滚轮 · 悬停队伍 | 缩放 0.5x ~ 2.5x · 显示完整信息（武将、兵 / 上限、战力、兵种） |
| G / 「抽卡 [G]」 | 打开抽卡（大地图暂停；交战中不能抽；有待安排武将时先弹名册） |
| E | 还没有副将时弹提示「还没有武将」（有副将时不响应；替换副将在得到新武将时弹出的名册窗口里做） |
| H | 主城 200 px（`roster.swap_radius_px`）内、不在交战：打开主城存放窗口；迁都弹窗时不响应 |
| B | 城中整编（主城 / 无守军的无主城里）：1–4 选兵种，0 / Esc 取消；整编中 5 s 不能动 |
| C / 「属性 [C]」 / 点小面板 | 展开 / 收起属性详情（不暂停）：统帅 = 主角、副将四维、统率项 L、兵力上限、战力倍率、减伤、速度、擅长兵种；变化高亮 |
| P | 暂停菜单（游戏时钟冻结）；菜单里 Y = 放弃本局（按失败结算），Esc / P 继续 |
| Y / N | 占领第二座城时的「迁都？」弹窗：Y 迁都（旧主城变无主城）/ N 不迁 |
| F1 | 调试显示：视野圈、游荡范围、所有路径（只在开发 / `build:smoke` 构建里有，`DEBUG_HOOKS`；正式版没有这个按键，帮助文字也不写） |

**抽卡窗口（G）**
| 按键 | 说明 |
|---|---|
| 空格 / Enter / 「抽一次」 | 付费 `50 + 5n` 点（封顶 150）→ 出 4 张（普通 / 稀有 / 史诗，卡面写效果和战力变化） |
| 1–4 / 点卡片 | 选一张（**必须选**：出了 4 张后 Esc 关不掉，刷新页面回到同一组） |
| F | 换一批：每章第 1 次免费，之后 20 点；每抽最多换 1 次 |
| 物品栏满 / 兵种令 | 数字键选丢哪件 / 选兵种；Esc 回到 4 张 |
| Esc | 待机或看结果时关闭窗口 |

**名册窗口**（队伍已满 3 将又得到新武将：俘获或抽卡；必须当场安排，不能关闭）
| 按键 | 说明 |
|---|---|
| E → 数字 / 点副将卡 | 替换：选换下哪位副将（主角不能换），再选被换下的人 R 流放（+20 点）或 H 存进主城 |
| R | 直接流放新武将（+20 点） |
| H | 直接把新武将存进主城（有主城、存放未满 3 个时） |
| Esc | 返回上一步 |

**主城存放窗口（H）**：1 / 2 选队里的副将，3–5 选主城里存放的武将（最多 3 个），Enter 执行（只选副将 = 存入、只选存放 = 出城入队、两边都选 = 对调），Esc 关闭。

**开发专用**（只在 `npm run dev`；正式构建没有）
| 按键 | 说明 |
|---|---|
| F2 | **调试菜单**（Phaser 画在画布上，不是 DOM）：1 点数 +200 · 2 立即获得主城：第一次按（还没有主城）→ 撤掉最近无主城的守军并直接立为主城（开局就是洛阳）；第二次按（已有主城）→ 直接把下一座城（最近的另一座无主城；没有就取最近的势力大本营，临时设为无主）交给玩家：撤掉守军，不清城防、不传送、不用攻城，立刻弹出迁都 Y / N（Y = 迁都到这座城，旧主城变无主城；N = 不迁，这座城保持无主；如果是临时设为无主的势力大本营，N 会把城还给原势力）· 3 填满地图队伍到 `max_ai_teams`（10）并再跑一次刷新检查，触发 T2「撤下过弱黄巾队」，提示写明撤下了哪支 / 没触发的原因 · 4 给一名武将：从自由池取一名（先 A 级）不在队里的武将，走和抽到武将卡同一个入口（`addGeneralOrQueue`）——有空位直接作为副将入队；满编进「待安排」并弹名册（替换 / 送回主城 / 流放），用来测换将、流放、存城 · 5 下一次抽卡必出武将卡（开关；只管下一抽，用掉自动关；不进存档，重开 / 读档清掉；自由池没有可给的武将时不换卡）· 6 最近的城城防归零：最近的、城防 > 0 的非我方城直接设为 0（和攻破时一样记城破时间），不和守军交战、守军不动；之后按 `regen_rule` 计时，用来测 QA-01 回复倒计时暂停 · 菜单打开时游戏暂停；1 / 5 不关菜单；2 / 3 / 4 / 6 选后关闭；抽卡等弹窗打开时 F2 不响应 · Esc / F2 关闭 |
| F5 / F9 | 手动存档 / 读档（开发和 `build:smoke` 构建；正式版只有自动存档） |

## 玩法（v0.6）

- **一局**：约 20 分钟、4 章（0 / 4 / 9 / 14 分钟：黄巾之乱、群雄并起、诸侯割据、天下三分）；刷新战力和克制倍率按章节走。失败 = 兵力 0 或主角 HP 0（死亡删档 → 结算 → 名望 / 解锁）；胜利 = 讨平 4 路名将军（曹操 / 关羽 / 周瑜 / 吕布）。开局 50 s 黄巾来袭（tuning_r2 U1-B，原 20 s），前 90 s 其他 AI 不追玩家。
- **实时接触战斗**（`systems/melee.js` 纯函数 `step`，同 v0.5）：接触掉兵、弓兵射程 / 弹药、冲锋与枪兵反冲、背击 ×1.3、士气 < 30 溃逃；兵种一队一种，枪 > 骑 > 弓 > 步 > 枪。v0.6 加「无接触结束」：连续 4 s 没接触、没追、没放箭 → separated。
- **主角永远是统帅**：统率项 L = 主角统率 + 副将统率 × 0.3（速度按 L，封顶 100）；副将擅长当前兵种 +0.05、敌队统帅擅长 +0.10。主角每章成长统率 +6、武力 +4（上限 100）。队伍最多 3 将（主角 + 2 副将），主角不能被替换 / 俘获。
- **抽卡（四选一）**：见上表。卡池按普通 / 稀有 / 史诗出 4 张：属性、物品、兵种令、操练、武将等；无保底。
- **名册**：满编时新武将可以替换副将、流放（+20 点）或存进主城（最多 3 个）；名将被换下 / 流放回自由池，黄巾头目直接消失。
- **主城**：攻下洛阳（扣城防 → 消灭守军 → 在城心 60 px 内待 5 s）立为主城。主城 / 无守军的无主城里回血、征兵、B 整编；H 存取武将。占第二座城时问是否迁都（Y / N），迁都后旧主城变无主城（仍可回血 / 征兵 / 整编）。
- **洛阳守军（T4 + power_recalc，策划 2026-10-23 定稿）**：守军满编战力**不是开局固定**，而是在玩家**开始和守军交战的那一刻**重算 = max(70, 0.5 × 当时玩家战力)（破城墙不算交战；破墙期间涨的战力，包括抽卡，算进去），这一场战斗中不变。剩余比例 = 当前兵 / 上次重算的满编（从 1 开始，累计）；重算后 兵 = 新满编 × 剩余比例 → 上一次攻城打掉的兵按比例保留。城名下的「守军战力」标签：不在交战时显示 max(70, 0.5 × 玩家战力) × 剩余比例，每秒刷新；交战中显示守军实际战力；「强于你」（红字）始终按标签上的数，标签 > 玩家战力（严格大于，相等不提示）才显示。第三方加入不重算：AI 正在打守军时玩家加入、或玩家在打守军时 AI 加入，守军都不重算、不变（AI 打掉的兵照样计入剩余比例）。实现：`city.garrisonRecalc` / `garrisonEngageSoldiers`（`melee.step` 开打时通过纯回调 `env.engageSoldiers` 取兵数）/ `garrisonPreviewPower`。
- **攻城 / 守城**：城防按章 230 / 420 / 700 / 870；攻城方接触城圆扣城防（每秒伤害 ≤ 城防上限 / 15，T1），城上弓箭射所有接触城圆的敌对队伍；守军和坐镇大本营的名将永不撤退；城防归零后：攻城方还贴着城、或玩家还在和守军交战 → 回复倒计时暂停；倒计时暂停时不重置，离开（不贴城、不交战）后接着计，累计满 20 s（且 8 s 没挨打）才开始每秒回 3%，回复后城防 > 0，要重新破城。换章：每秒伤害上限立即换成新章「城防上限 ÷ 15」；城防满的（没被打过 / 已回满）抬到新章上限，不满的（正在被攻 / 还没回满）当前值不变。
- **主城被攻**：第 2 章起在主城里连续待 20 s → 最近的未讨伐势力派兵（或刷 0.8–1.2 倍讨伐军）来攻；第 3 章起离开主城 > 500 px 每分钟 20% 被趁虚攻打；黄巾不派（`raid_exclude`）。城破后敌人在城心待 10 s → 主城失守（变回无主城、城防 30%、存放的武将流散）。
- **AI**：看见对方时 r = 我方 / 对方战力，r ≤ flee_ratio 逃（黄巾 0.4，**等于也逃**；其他势力按性格 0.6 / 0.8 / 1.0），r ≥ chase_ratio 追；不追弱 3 倍以上的队伍。flee_ratio 只管「看见就逃」，交战中的撤退不变（士气 < 30 溃逃）。名将军 1–2 章坐镇大本营，3 章起领地 420 px 内追击（名将军逃跑规则本轮没改）。
- **刷新**：最多 10 支 AI，每 12 s 补一支；场上已满时 T2 撤下 1 支过弱的普通黄巾队（战力 < 0.6 × 玩家、不在交战、距玩家 > 400 px）再补。某势力没被讨伐、场上又没它的队伍 → 在大本营出校尉军。
- **侦察**：300 px 内看清兵种、兵数、强弱色、克制箭头；300–500 px 只看兵种和约数。
- **游戏时钟**：所有计时走 `world.clock`；抽卡 / 名册 / 主城窗口和暂停菜单打开时整个世界冻结。

## 游戏时钟（core/GameClock.js，v0.4 pause_scope）

所有计时都走游戏时钟 `world.clock.now`，不用真实时间：战斗时长、战后保护、玩家无敌、平局冷却、AI 状态计时与忽略名单、补充刷新、自动存档间隔。时钟只在大地图 `update` 里按帧间隔推进（单帧最多 250ms）；打开抽卡/名册窗口时大地图暂停，时钟和全部计时一起冻结（单测 `tests/gameClock.test.js`，冒烟测试也会检查）。

## 平台适配（src/platform/，为以后 iOS / 微信 / 抖音小游戏准备）

- `storage.js`：存储接口 `get / set / remove`。现在用 `LocalStorageAdapter`（localStorage 不可用时退回内存）；小游戏换 `WxStorageAdapter(wx | tt)`。**除这里以外不许直接用 localStorage。**
- `lifecycle.js`：`onHide(cb)`。网页 = visibilitychange / pagehide / beforeunload；小游戏换 `WxLifecycleAdapter`（wx.onHide）。
- `screen.js`：屏幕尺寸。网页 = `window.innerWidth/innerHeight` + Phaser RESIZE（与以前相同）；小游戏换 `WxScreenAdapter(wx | tt)`（getSystemInfoSync）。入口 `main.js` 只通过 `scaleConfig()` 取尺寸。
- `input.js`：输入动作层。场景只监听动作（`move` 向量、`moveTo` 点地面、`confirm`/`cancel`/`primary`/`choose N`/`release`/`yes`/`no`、`openGacha`、`toggleStats`（C）、`save`/`load`、`debugVision`/`debugPoints`、`zoom`、`tap`、`any`），不碰原始按键。现在有 `KeyboardSource`（键位与以前完全一样，见 `DEFAULT_BINDINGS`）和 `PointerSource`（鼠标/触屏点按、滚轮）；触摸摇杆以后实现 `{ moveVector(), attach(emit), detach() }` 再 `actions.addSource()` 即可。
- `systems/save.js` 是纯逻辑，存储由调用方传入（单测用 `MemoryStorageAdapter`）。

## 存档（v6，systems/save.js）

- **单槽自动存档**：键 `sanguo-run-v1`（局外数据 `sanguo-meta-v1`），JSON，`saveVersion` = 6，带 `balanceVersion`、`mapSeed`、`savedAt`、`reason`。全部经过 `platform/storage`（不直接碰 localStorage）。
- **什么时候存**：每 30 s 游戏时间、换章、战斗前后、抽卡扣点出 4 张后 / 每次选择后、名册 / 主城存放每次操作后、弹窗关闭、页面隐藏 / 关闭；交战中每 1 s 存一次战斗快照（读档原样继续，有 3 s 倒计时）。死亡或通关删档。
- **内容**：玩家队（位置、兵、兵种、武将 id + 成长值、物品）、点数、抽卡状态（`state.gacha`：已抽次数、**当前这组 4 张**、本章免费换一批是否已用）、待安排武将队列、主城 `homeCity`、主城存放 `cityStore`、五座城（城主、城防、破城 / 回复计时）、洛阳守军队（随 AI 队保存，带上次重算的满编 `garrisonFull` / 兵 `garrisonN` → 剩余比例读档后不变）、run（runId / runSeed / 章节 / 主角 HP / 讨平名将 / 主城被攻计时）、全部 AI 队与记忆、实时战斗快照、刷新计数与定时器、黄巾头目名字池、**随机数流 `rng: { team, gacha, combat, spawn, ai }`**、游戏时钟、镜头缩放。
- **不能重掷**：抽卡、战斗、刷新、AI 游荡都用存档里的种子流；同一 runSeed + 同样的操作 → 同样的结果（可复现，见上）。
- **迁移**（`MIGRATIONS[v]` 把 v 升到 v+1，读档时逐级执行）：
  - v4 → v5（v0.5 → v0.6）：旧的抽卡待选丢弃并退还该次点数；`state.gacha` 按已抽次数建立；`cityStore = []`、`homeCity = null`；五城按当前章节重建（不放守军）；主角成长从当前章节算起。
  - v5 → v6（可复现）：补 `rng.ai = streamSeed(runSeed, 'ai')`。
  - v3 及更早（v0.4 键 `sanguo-save`）不迁移：启动时改名为 `sanguo-save-legacy` 归档并提示一次。
- **读档容错**：JSON 损坏 / 字段非法 / 引用不存在的武将 → corrupt；版本比游戏新 → too_new；地图种子不同或缺迁移 → incompatible。都只显示原因并提供新游戏，不会崩溃。数值版本不同但数据有效 → 可以继续并提示一次。

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
  scenes/ BootScene / TitleScene / WorldScene / UIScene / GachaScene / RosterScene / CityScene（主城存放）/ RunEndScene（结算）
  ui/widgets.js                  按钮/文字/档位颜色等占位 UI 组件；StatsHud.js 属性面板；DebugMenu.js F2 调试菜单（仅开发，动态加载）
  systems/ v0.5/v0.6 新增：city.js（城池 / 攻城 / 守军重算）、melee.js + fieldBattle.js + combatAI.js（实时战斗）、run.js / runConfig.js / meta.js（一局规则 / 局外）、gachaOffer.js（四选一）、leader.js（统率项）、devTools.js（F2 调试菜单逻辑，仅开发）
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
