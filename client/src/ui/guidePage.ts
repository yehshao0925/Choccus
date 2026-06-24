/**
 * ?mode=guide — an illustrated, lightly-story-driven guide to the map tiles, the
 * cake-bomb, the power-ups and the characters. Reuses the REAL candyArt
 * generators so the guide can never drift from what the game actually draws.
 * Pure DOM: no sim, no net, no wall-clock.
 */
import { ItemKind } from '../../../shared/types';
import {
  CANDY_KEYFRAMES,
  TH,
  TW,
  cakeBombHtml,
  cubeHtml,
  explosionHtml,
  floorHtml,
  itemHtml,
  playerHtml,
  shellHtml,
} from '../render/candyArt';

// One showcase tile: a floor cell for head-room above a floor cell carrying the
// art (entities sit on a floor exactly like the board; tiles draw their cube on
// it). Bottom-anchored so every entity shares one floor baseline; heads/candles
// overflow up into the head-room cell. Scaled up for legibility.
function stage(art: string): string {
  const cell = (top: number, checker: number, extra: string): string =>
    `<div style="position:absolute;left:0;top:${top}px;width:${TW}px;height:${TH}px;">` +
    `${floorHtml(checker)}${extra}</div>`;
  return (
    `<div style="height:150px;display:flex;justify-content:center;align-items:flex-end;overflow:visible;">` +
      `<div style="position:relative;width:${TW}px;height:${TH * 2}px;transform:scale(1.5);transform-origin:bottom center;">` +
        cell(0, 1, '') +
        cell(TH, 0, art) +
      `</div>` +
    `</div>`
  );
}

// The blast is a 4-way cross whose arms overflow into neighbours, so show it in a
// 3×3 floor patch with the blast in the centre — accurate and self-contained.
function crossStage(): string {
  let cells = '';
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 3; x++) {
      const art = x === 1 && y === 1 ? explosionHtml(15) : '';
      cells +=
        `<div style="position:absolute;left:${x * TW}px;top:${y * TH}px;width:${TW}px;height:${TH}px;">` +
        `${floorHtml((x + y) & 1)}${art}</div>`;
    }
  }
  return (
    `<div style="height:150px;display:flex;justify-content:center;align-items:center;overflow:visible;">` +
      `<div style="position:relative;width:${TW * 3}px;height:${TH * 3}px;transform:scale(.9);transform-origin:center;">${cells}</div>` +
    `</div>`
  );
}

// A 3-D keyboard keycap.
function keycap(label: string, wide = false): string {
  return (
    `<span style="display:inline-flex;align-items:center;justify-content:center;` +
    `min-width:${wide ? 70 : 34}px;height:34px;padding:0 10px;` +
    `background:linear-gradient(180deg,#FFFFFF,#EFE0C5);color:#7A4A2B;` +
    `font:800 15px 'Nunito',system-ui,sans-serif;border-radius:9px;` +
    `box-shadow:0 3px 0 #D9C19A,inset 0 1px 1px #fff;">${label}</span>`
  );
}

// One controls row: the key(s) on the left, what they do on the right.
function ctrlRow(keys: string, action: string): string {
  return (
    `<div style="display:flex;align-items:center;gap:14px;padding:9px 2px;border-bottom:1px solid rgba(150,108,58,.14);">` +
      `<div style="flex:0 0 168px;display:flex;gap:5px;flex-wrap:wrap;">${keys}</div>` +
      `<div style="color:#5C3A1F;font-size:14px;line-height:1.4;">${action}</div>` +
    `</div>`
  );
}

function card(stageHtml: string, name: string, desc: string): string {
  return (
    `<div style="width:158px;display:flex;flex-direction:column;align-items:center;text-align:center;">` +
      stageHtml +
      `<div style="font-weight:800;color:#5C3A1F;font-size:15px;margin-top:2px;">${name}</div>` +
      `<div style="color:#8A6A48;font-size:12px;line-height:1.45;margin-top:3px;">${desc}</div>` +
    `</div>`
  );
}

function section(title: string, intro: string, cardsHtml: string): string {
  return (
    `<h2 style="margin:24px 0 6px;color:#7A4A2B;font-size:21px;border-bottom:2px dashed #E3CBA0;padding-bottom:6px;">${title}</h2>` +
    (intro ? `<p style="margin:0 0 12px;color:#8A6A48;font-size:13px;line-height:1.55;">${intro}</p>` : '') +
    `<div style="display:flex;flex-wrap:wrap;gap:18px 12px;justify-content:center;">${cardsHtml}</div>`
  );
}

export function runGuide(): void {
  const mount = document.getElementById('app');
  if (!mount) throw new Error('#app mount point missing');

  // The page shell centres #app with flexbox; a tall guide would clip at the top
  // and not scroll. This screen owns the whole page, so switch body to normal
  // block flow (back-link reloads into the lobby with a fresh shell).
  document.body.style.display = 'block';
  document.body.style.alignItems = '';
  document.body.style.padding = '0';

  const tiles = [
    card(stage(cubeHtml('wall')), '巧克力牆（硬磚）', '打不破的牆，會擋住爆炸。'),
    card(stage(cubeHtml('block')), '蛋糕磚（軟磚）', '可以炸開，30% 機率掉一個道具。'),
    card(stage(''), '地板', '可以自由走動的地方。'),
  ].join('');

  const blast = [
    card(stage(cakeBombHtml()), '蠟燭蛋糕（炸彈）', '放下後 3 秒，蠟燭燒完就引爆。'),
    card(crossStage(), '融化十字（爆炸）', '十字熔流；遇硬磚停、炸開軟磚、可連鎖。碰到就被困住。'),
    card(stage(shellHtml()), '糖殼（被困住）', '5 秒內隊友碰到＝救援；敵人碰到或超時＝淘汰。'),
  ].join('');

  const items = [
    card(stage(itemHtml(ItemKind.FIRE)), '鮮奶油（火力）', '爆炸範圍 +1（上限 7）。'),
    card(stage(itemHtml(ItemKind.CANNON)), '雞蛋（炸彈數）', '可同時多放一顆蛋糕（上限 6）。'),
    card(stage(itemHtml(ItemKind.SPEED)), '翅膀（速度）', '移動更快，每顆 +0.4（上限 +2.0）。'),
  ].join('');

  const chars = [
    card(stage(playerHtml(0, false)), '草莓啵啵', '紅隊隊長，酸甜帶勁——就是「你」。'),
    card(stage(playerHtml(1, false)), '薄荷啵啵', '清涼冷靜，最會躲爆炸。'),
    card(stage(playerHtml(2, false)), '焦糖啵啵', '甜中帶苦，後勁十足。'),
    card(stage(playerHtml(3, false)), '藍莓啵啵', '藍色小子，莓在怕的。'),
    card(stage(playerHtml(0, true)), '烘焙機器人', '甜點工廠的練習機器人，沒人坐的位子由它補上，公平開打。'),
  ].join('');

  const controls =
    `<h2 style="margin:24px 0 6px;color:#7A4A2B;font-size:21px;border-bottom:2px dashed #E3CBA0;padding-bottom:6px;">操作方式</h2>` +
    `<div style="max-width:480px;margin:6px auto 0;background:rgba(255,255,255,.5);border-radius:16px;padding:4px 18px;box-shadow:0 4px 0 #EAD6B8;">` +
      ctrlRow(keycap('↑') + keycap('↓') + keycap('←') + keycap('→'), '移動角色') +
      ctrlRow(keycap('Space', true), '放下一顆蠟燭蛋糕（3 秒後引爆）') +
      ctrlRow(keycap('R'), '重新開一局（單人練習）') +
      ctrlRow(
        `<span style="display:inline-flex;align-items:center;height:34px;padding:0 12px;background:#FCE9C6;color:#7A4A2B;font-weight:800;font-size:14px;border-radius:9px;box-shadow:0 3px 0 #E6CF9E;">🚶 走過去</span>`,
        '走到被糖殼困住的隊友身上＝救援（不用按鍵）',
      ) +
    `</div>`;

  mount.innerHTML =
    `<style>${CANDY_KEYFRAMES}</style>` +
    `<div style="min-height:100vh;width:100%;box-sizing:border-box;background:linear-gradient(180deg,#FBF1DC,#F2E0BF);font-family:'Nunito',system-ui,sans-serif;padding:22px 16px 70px;">` +
      `<div style="max-width:780px;margin:0 auto;">` +
        `<a href="./" style="display:inline-block;color:#7A4A2B;font-weight:800;text-decoration:none;background:#fff;padding:8px 16px;border-radius:999px;box-shadow:0 4px 0 #EAD6B8;">← 返回大廳</a>` +
        `<h1 style="margin:14px 0 6px;color:#5C3A1F;font-size:30px;font-family:'Baloo 2','Nunito',sans-serif;">奶油啵啵爆 · 玩法介紹</h1>` +
        `<p style="margin:0;color:#8A6A48;font-size:14px;line-height:1.6;">歡迎來到<b>奶油蛋糕王國</b>。這裡的巧克力一加熱就融化噴發、一冷卻就凝成糖殼——精靈們就用這特性較量：擠出一顆蠟燭蛋糕，等它融化炸開，把對手包進糖殼裡。最後還站著的隊伍，就是今天的甜點冠軍（打滿 3 分鐘則比存活人數與發育）。</p>` +
        controls +
        section('地圖', '蛋糕王國的場地：巧克力磚牆、可以炸開的蛋糕磚，還有走道。', tiles) +
        section('炸彈與爆炸', '巧克力的相變就是武器——融化＝攻擊，凝固＝把人困住的糖殼。', blast) +
        section('道具', '炸開蛋糕磚有機會掉烘焙材料，撿了立刻變強。', items) +
        section('角色', '主角是住在蛋糕王國的奶油精靈「啵啵」，頭頂一坨鮮奶油。四種口味是四位選手（同一隻精靈、不同顏色，方便分隊），空位則由烘焙機器人補上。', chars) +
      `</div>` +
    `</div>`;
}
