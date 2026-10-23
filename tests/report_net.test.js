// QA-14：玩家胜时战报带「兵 开战前→现在」，与 HUD 兵力一致（= 开战前 − 损 + 收编，封顶上限）。npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('fieldBattle._defeat：玩家胜方战报追加 兵 N0start→W.team.soldiers', () => {
  const src = readFileSync(new URL('../src/systems/fieldBattle.js', import.meta.url), 'utf8');
  assert.match(src, /if \(W\.team\.is_player\) outcome\.text \+= ` 兵\$\{roundHalfUp\(wN0\)\}→\$\{W\.team\.soldiers\}`/);
  // 顺序：在 applyBattleResult（收编、封顶）之后
  assert.ok(src.indexOf('outcome = applyBattleResult(W.team') < src.indexOf('if (W.team.is_player) outcome.text'));
});
