import { isEn, tRoomName } from '../core/i18n';

/** 字幕（日本語）と、speechSynthesis が読む英語の組。 */
export type RadioLine = readonly [ja: string, en: string];

const lastIndex = new Map<readonly RadioLine[], number>();
/** プール → 番号、選んだ文 → 出どころのプール番号（言い回しが違っても「同じ種類の台詞」と分かるように） */
const poolIds = new Map<readonly RadioLine[], number>();
const textGroup = new Map<string, number>();

/**
 * 無線の重複判定に使う「台詞の種類」のキー。pickRadio で選んだ文はプール単位（言い回し違いも同じ種類）、
 * それ以外（名前入りの動的な文など）は文そのもの。
 */
export function radioGroupKey(text: string): string {
  const g = textGroup.get(text);
  return g !== undefined ? `pool#${g}` : `text:${text}`;
}

/**
 * プールから 1 文を選ぶ。同じプールで直前と同じ文は続けて出さない。
 * `vars` があるときは `{name}` を置き換える。プールの配列そのものを記憶するので、毎回新しい配列を渡さない。
 */
export function pickRadio(pool: readonly RadioLine[], vars?: Readonly<Record<string, string>>): RadioLine {
  const n = pool.length;
  if (n === 0) throw new Error('empty radio pool');
  let idx = 0;
  if (n > 1) {
    const prev = lastIndex.get(pool);
    idx = Math.floor(Math.random() * n);
    if (idx === prev) idx = (idx + 1) % n;
    lastIndex.set(pool, idx);
  }
  const line = pool[idx]!;
  if (!vars) {
    let pid = poolIds.get(pool);
    if (pid === undefined) {
      pid = poolIds.size;
      poolIds.set(pool, pid);
    }
    textGroup.set(line[0], pid);
    return line;
  }
  const apply = (s: string) => s.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? '');
  // 部屋名などを埋め込んだ文は中身が違えば別の知らせなので、種類でまとめない（文そのもので判定）
  return [apply(line[0]), apply(line[1])];
}

/** 英語読み上げ用の部屋名。日本語 UI では日本語を TTS に渡さない。 */
export function voiceRoom(name: string): string {
  return isEn() ? tRoomName(name) : 'Room';
}

export function roomClearLine(roomName: string, anotherDoor: boolean): RadioLine {
  return pickRadio(anotherDoor ? ROOM_CLEAR_EXIT : ROOM_CLEAR, {
    room: roomName,
    roomEn: voiceRoom(roomName),
  });
}

export function contactInRoom(roomName: string): RadioLine {
  return pickRadio(CONTACT_ROOM, { room: roomName, roomEn: voiceRoom(roomName) });
}

export function manDownLine(who: string): RadioLine {
  return pickRadio(MAN_DOWN, { who });
}

export function flankLine(pin: string, flank: string): RadioLine {
  return pickRadio(FLANK, { pin, flank });
}

export function cellSetLine(cell: string, dirJa: string, dirEn: string): RadioLine {
  return pickRadio(CELL_SET, { cell, dirJa, dirEn });
}

export function reinforceLine(cell: string): RadioLine {
  return pickRadio(REINFORCE, { cell });
}

export function dugInGasLine(roomName: string): RadioLine {
  return pickRadio(DUG_IN_GAS, { room: roomName, roomEn: voiceRoom(roomName) });
}

export function doorAck(order: string, open: boolean): readonly RadioLine[] {
  switch (order) {
    case 'stack':
      return open ? ACK_STACK_OPEN : ACK_STACK_CLOSED;
    case 'clear':
      return open ? ACK_CLEAR_OPEN : ACK_CLEAR_CLOSED;
    case 'flashClear':
      return ACK_FLASH;
    case 'breachClear':
      return ACK_BREACH;
    case 'c2Clear':
      return ACK_C2;
    case 'gasClear':
      return ACK_GAS;
    case 'pieDoor':
      return ACK_HOLD_DOOR;
    case 'check':
      return ACK_CHECK;
    case 'disarm':
      return ACK_DISARM;
    case 'mirror':
      return ACK_MIRROR;
    default:
      return ACK_ROGER;
  }
}

/** 同時突入のカウント。全員が同じ数を聞くのでバリエーションを付けない。 */
export const BREACH_COUNTDOWN: RadioLine = [
  '全班配置完了。3、2、1、ブリーチ！',
  'All teams set. 3, 2, 1, breach!',
];

const ASSAULT_GO: readonly RadioLine[] = [
  ['全隊、突入開始。容疑者は武装している、注意しろ。', 'All teams, go. Suspect is armed.'],
  ['エントリーチーム、突入しろ。武装している。', 'Entry team, go. He is armed.'],
  ['全隊、ゴー。突入だ。容疑者は武装している。', 'All teams, go go go. Make entry. Armed suspect.'],
];

const STACK_SPLIT: readonly RadioLine[] = [
  ['全班、各入口へ展開してスタックしろ。', 'All teams, split up and stack on your entries.'],
  ['各班、担当の入口にスタック。', 'Each team, stack on your entry.'],
  ['入口を分けろ。スタックして待機。', 'Split the entries. Stack up and hold.'],
];

const STACK_FRONT: readonly RadioLine[] = [
  ['全班、正面ドア前にスタックしろ。', 'All teams, stack up on the front entry.'],
  ['正面入口にスタック。', 'Stack on the front entry.'],
  ['全員、正面にスタックして突入準備。', 'All teams, stack on the front. Ready for entry.'],
];

const CELL_SET: readonly RadioLine[] = [
  ['{cell}班、{dirJa}配置完了。', '{cell}, stacked on the {dirEn}.'],
  ['{cell}、{dirJa}にスタック完了。', '{cell} is stacked at the {dirEn}.'],
  ['{cell}班、{dirJa}で配置についた。突入準備よし。', '{cell}, set on the {dirEn}. Ready for entry.'],
];

/** 既存の同時突入テストが、全バリアントにスタック／突入の語を要求する。 */
export const ENTRY_COORD_POOLS: readonly (readonly RadioLine[])[] = [
  ASSAULT_GO,
  STACK_SPLIT,
  STACK_FRONT,
  CELL_SET,
];

export const FLANK: readonly RadioLine[] = [
  ['{pin}は正面を釘付けにしろ。{flank}は回り込め。', '{pin}, pin the front. {flank}, flank around.'],
  ['正面は{pin}が押さえる。{flank}は裏へ回り込め。', '{pin} pins the front. {flank}, get behind him.'],
  ['{pin}が釘付け。{flank}は別ルートで挟撃しろ。', '{pin} is pinning. {flank}, take the flank.'],
];

const CONTACT: readonly RadioLine[] = [
  ['接触！武装した容疑者だ！', 'Contact! Armed suspect!'],
  ['容疑者を確認、交戦する！', 'Suspect spotted, engaging!'],
  ['こちら接触。対象は武装している！', 'Contact, contact! He is armed!'],
];

const CONTACT_ROOM: readonly RadioLine[] = [
  ['接触！{room}に武装した容疑者！', 'Contact! Armed suspect in {roomEn}!'],
  ['{room}で容疑者を確認。交戦する！', 'Suspect spotted in {roomEn}. Engaging!'],
  ['こちら{room}、接触！', 'Contact in {roomEn}!'],
];

const RELOAD: readonly RadioLine[] = [
  ['リロード中、カバーを頼む！', 'Reloading! Cover me!'],
  ['マガジン交換！射線を頼む！', 'Changing mags! Cover!'],
  ['弾を込める。カバーしてくれ！', 'Reloading. I need cover!'],
];

const FLASH: readonly RadioLine[] = [
  ['フラッシュバン、投下！', 'Flashbang out!'],
  ['閃光弾を投げた！', 'Flashbang deployed!'],
  ['バンを入れた。目を守れ！', 'Bang out! Avert your eyes!'],
];

const GAS: readonly RadioLine[] = [
  ['CSガス、投下！', 'Deploying CS gas!'],
  ['催涙ガスを投入する！', 'CS gas out!'],
  ['ガスを入れる。マスクを確認しろ！', 'Gas deployed! Check your masks!'],
];

const ROOM_CLEAR: readonly RadioLine[] = [
  ['{room}、クリア！', '{roomEn}, clear!'],
  ['{room}、異常なし！', '{roomEn} is clear!'],
  ['{room}を確保した！', '{roomEn} secure!'],
];

const ROOM_CLEAR_EXIT: readonly RadioLine[] = [
  ['{room}、クリア！別のドアがある。', '{roomEn}, clear! Another door.'],
  ['{room}、クリア！未確認の出口あり。', '{roomEn} is clear. Another door.'],
  ['{room}を確保。別扉に注意。', '{roomEn} secure. Watch the other door.'],
];

const MAN_DOWN: readonly RadioLine[] = [
  ['{who}が負傷ダウン！', '{who} is down!'],
  ['オフィサーダウン！{who}が被弾！', 'Officer down! {who} is hit!'],
  ['{who}が倒れた！援護しろ！', '{who} is down! Cover him!'],
];

const ACK_ROGER: readonly RadioLine[] = [['了解。', 'Roger that.']];

const ACK_STACK_CLOSED: readonly RadioLine[] = [
  ['了解。ドア脇にスタックする。', 'Copy. Stacking up on the door.'],
  ['了解。ドアに付いて待機する。', 'Roger. We are stacking on the door.'],
  ['了解だ。ドア脇で突入準備する。', 'Copy that. Stacking and ready at the door.'],
];

const ACK_STACK_OPEN: readonly RadioLine[] = [
  ['了解。入口脇にスタックする。', 'Copy. Stacking on the entry.'],
  ['了解。開いた入口にスタックする。', 'Roger. Stacking up on the open entry.'],
  ['了解だ。入口にスタックして待つ。', 'Copy. We are stacking at the entry.'],
];

const ACK_CLEAR_OPEN: readonly RadioLine[] = [
  ['了解。突入してクリアする！', 'Copy. Moving in and clearing!'],
  ['了解。部屋に入ってクリアする！', 'Roger. We are going in to clear!'],
  ['了解だ。突入開始、クリアする！', 'Copy that. Making entry and clearing!'],
];

const ACK_CLEAR_CLOSED: readonly RadioLine[] = [
  ['了解。ドアを開けて突入する！', 'Copy. Opening the door and moving in!'],
  ['了解。開放してクリアする！', 'Roger. We will open it and clear!'],
  ['了解だ。ドアを開けて入る！', 'Copy. Opening and going in!'],
];

const ACK_FLASH: readonly RadioLine[] = [
  ['了解。フラッシュバンで突入する！', 'Copy. Flashbang, then we clear!'],
  ['了解。閃光弾を入れて入る！', 'Roger. Bang and clear!'],
  ['了解だ。バンを投げて突入する！', 'Copy that. Flashbang out, then entry!'],
];

const ACK_BREACH: readonly RadioLine[] = [
  ['了解。ブリーチして突入する！', 'Copy. Breaching and clearing!'],
  ['了解。蹴破って入る！', 'Roger. We are breaching the door!'],
  ['了解だ。強行突入する！', 'Copy. Breach and clear!'],
];

const ACK_C2: readonly RadioLine[] = [
  ['了解。爆薬を設置して突入する！', 'Copy. Explosive breach and clear!'],
  ['了解。C2を付けて入る！', 'Roger. Setting a charge, then we breach!'],
  ['了解だ。爆破ブリーチで突入する！', 'Copy. Charge the door and move in!'],
];

const ACK_GAS: readonly RadioLine[] = [
  ['了解。催涙ガスを入れて突入する！', 'Copy. Gas and clear!'],
  ['了解。CSガスを投下して入る！', 'Roger. Deploying CS gas, then we move in!'],
  ['了解だ。ガスを入れてからクリアする！', 'Copy. CS gas, then we clear!'],
];

const ACK_HOLD_DOOR: readonly RadioLine[] = [
  ['了解。ドアを開けて外から警戒する。', 'Copy. Opening the door and holding outside.'],
  ['了解。外から室内を確認する。', 'Roger. We will cover the room from outside.'],
  ['了解だ。入らずにドアを押さえる。', 'Copy. Holding the door. We are not going in.'],
];

const ACK_CHECK: readonly RadioLine[] = [
  ['了解。ドアに付いて施錠と罠を確認する。', 'Copy. Stacking up and checking the door.'],
  ['了解。ドアの鍵と仕掛けを確認する。', 'Roger. Checking the door for locks and traps.'],
  ['了解だ。ドア際で確認する。', 'Copy that. Moving to check the door.'],
];

const ACK_DISARM: readonly RadioLine[] = [
  ['了解。トラップを解除する。', 'Copy. Moving to disarm the trap.'],
  ['了解だ。ドアの仕掛けを外す。', 'Roger. Disarming the door trap.'],
];

const ACK_MIRROR: readonly RadioLine[] = [
  ['了解。ミラーでドア下を確認する。', 'Copy. Mirroring under the door.'],
  ['了解だ。ワンドで室内を覗く。', 'Roger. Checking under the door with the wand.'],
];

const ACK_MOVE: readonly RadioLine[] = [
  ['了解。指定地点へ移動して警戒する。', 'Copy. Moving to position.'],
  ['了解。そこへ行って押さえる。', 'Roger. Moving up and covering.'],
  ['了解だ。指示位置で待機する。', 'Copy that. Moving to the mark.'],
];

const ACK_OVERWATCH: readonly RadioLine[] = [
  ['了解。この射線をロックする。', 'Copy. Holding this sector.'],
  ['了解。照準方向を警戒する。', 'Roger. Covering your line of fire.'],
  ['了解だ。その方向を見続ける。', 'Copy. We have got that sector.'],
];

const ACK_RESTRAIN: readonly RadioLine[] = [
  ['了解。対象を確保する。', 'Copy. Moving to cuff the suspect.'],
  ['了解。拘束に向かう。', 'Roger. We will secure the suspect.'],
  ['了解だ。容疑者を確保する。', 'Copy. Taking him into custody.'],
];

const ACK_RESTRAIN_SEARCH: readonly RadioLine[] = [
  ['了解。周囲の確保対象を確認する。', 'Copy. Checking for anyone to secure.'],
  ['了解。近くに確保できる者がいないか見る。', 'Roger. Looking for a suspect to cuff.'],
];

const ACK_HOLD: readonly RadioLine[] = [
  ['了解。ここで待機する。', 'Copy. Holding position.'],
  ['了解。この場を押さえる。', 'Roger. Holding here.'],
  ['了解だ。現在位置で警戒する。', 'Copy. We will hold this position.'],
];

const ACK_FOLLOW: readonly RadioLine[] = [
  ['了解。隊列に戻る。', 'Copy. Falling in.'],
  ['了解。後ろに付く。', 'Roger. On you.'],
  ['了解だ。隊形に復帰する。', 'Copy. Forming up.'],
];

export const MODE_SLOW: readonly RadioLine[] = [
  ['了解。慎重に入る。', 'Copy. Taking it slow.'],
  ['了解。急がず、確認しながら入る。', 'Roger. We will clear it carefully.'],
  ['了解だ。慎重進入に切り替える。', 'Copy. Switching to a slow entry.'],
];

export const MODE_DYNAMIC: readonly RadioLine[] = [
  ['了解。一気に入る。', 'Copy. Going in dynamic.'],
  ['了解。強行突入に切り替える。', 'Roger. We are going dynamic.'],
  ['了解だ。速度優先で入る。', 'Copy. Dynamic entry. We are moving fast.'],
];

export const STACKED_READY: readonly RadioLine[] = [
  ['スタック完了。突入準備よし。', 'Stacked and ready.'],
  ['位置についた。合図を待つ。', 'We are in position. Waiting on you.'],
  ['ドアに付いた。準備完了。', 'At the door. Ready to make entry.'],
];

export const CHECK_FROM_DOOR: readonly RadioLine[] = [
  ['ドアから室内を確認している。', 'Checking the room from the door.'],
  ['入口から中を見ている。まだ入らない。', 'Eyes on the room. Holding at the door.'],
  ['ドアの外から確認中。', 'Checking from the doorway.'],
];

export const CRACK_DOOR: readonly RadioLine[] = [
  ['扉を少し開けて中を見る。', 'Cracking the door.'],
  ['ドアを細く開けた。確認する。', 'Door is cracked. Checking inside.'],
  ['少し開けて室内を見る。', 'Cracking it. Taking a look.'],
];

export const QUIET_ENTRY: readonly RadioLine[] = [
  ['外からの確認完了。静かに入る。', 'Doorway is clear. Moving in quiet.'],
  ['入口は見た。入る。', 'I have checked the door. Going in.'],
  ['確認できた。慎重に進入する。', 'It is clear enough. Moving in slow.'],
];

export const MOVE_IN: readonly RadioLine[] = [
  ['突入、クリアする！', 'Moving in, clearing the room!'],
  ['入る！クリアしろ！', 'Going in! Clear it!'],
  ['突入開始！', 'Making entry!'],
];

export const BREACH_CALL: readonly RadioLine[] = [
  ['ブリーチ！', 'Breaching!'],
  ['ドアを破る！', 'Breaching the door!'],
  ['ブリーチする、下がれ！', 'Breach! Stand clear!'],
];

export const BREACH_IN: readonly RadioLine[] = [
  ['ブリーチ！突入する！', 'Breaching! Moving in!'],
  ['蹴破った！ゴー！', 'Breach! Go, go, go!'],
  ['ブリーチ完了、突入！', 'Door is breached. Move in!'],
];

export const C2_PLANT: readonly RadioLine[] = [
  ['爆薬を設置する！退避しろ！', 'Charge is set! Stand clear!'],
  ['C2を付けた。下がれ！', 'Planting the charge! Get back!'],
];

export const C2_DETONATE: readonly RadioLine[] = [
  ['起爆！突入しろ！', 'Breach! Move in!'],
  ['爆破した！ゴー、ゴー！', 'Breach! Go, go, go!'],
];

export const DOOR_LOCKED: readonly RadioLine[] = [
  ['ドアは施錠されている。ブリーチが要る。', "Door's locked. Need a breach."],
  ['施錠だ。蹴るか爆薬が要る。', "It is locked. We need a breach."],
  ['開かない。ブリーチを頼む。', "Won't open. Requesting a breach."],
];

export const FLASH_GO: readonly RadioLine[] = [
  ['フラッシュ炸裂！突入！', 'Flashbang is out. Go, go, go!'],
  ['バンが割れた。入れ！', 'Bang went off. Move in!'],
  ['閃光、確認。突入する！', 'Flash is off. Making entry!'],
];

export const GAS_GO: readonly RadioLine[] = [
  ['ガス展開完了。マスク確認、突入！', 'Gas is deployed. Masks on, moving in!'],
  ['CSが回った。入る！', 'CS is in. Go!'],
  ['ガス展開。マスクを見て、突入！', 'Gas out. Check masks and move in!'],
];

export const COVER_CALL: readonly RadioLine[] = [
  ['奥に容疑者！カバーして投降を呼べ！', 'Suspect ahead! Take cover and call him out!'],
  ['壁の向こうに容疑者。投降を勧告する！', 'Suspect behind cover. Calling for surrender!'],
  ['容疑者を確認。撃たず、降伏を叫ぶ！', 'Suspect spotted. Holding fire and calling him out!'],
];

export const LESS_LETHAL: readonly RadioLine[] = [
  ['射線に人がいる。非致死で行く！', 'No shot. Deploying less-lethal!'],
  ['人質に注意！ペッパーボールで制圧する！', 'Hostage in the line. Pepperball only!'],
  ['実弾は撃つな。非致死弾を使う！', 'Hold live rounds. Less-lethal out!'],
];

export const CUFF: readonly RadioLine[] = [
  ['容疑者を確保。武器も回収した。', 'Suspect in custody. Weapon secured.'],
  ['拘束完了。武器を押収した。', 'He is cuffed. Weapon is secure.'],
  ['容疑者を拘束した。武器も押さえた。', 'Suspect secured. We have the weapon.'],
];

/** 投降した容疑者の拘束に向かう（傍受される。拘束役が無防備になる隙のヒント） */
export const RESTRAIN_GO: readonly RadioLine[] = [
  ['容疑者が投降した。拘束に向かう、援護しろ。', 'Suspect surrendering, moving to restrain. Cover me.'],
  ['投降を確認。手錠をかけに行く。周囲を見ていてくれ。', 'He is giving up. Moving to restrain him. Watch my back.'],
  ['一人投降した。拘束する、援護を頼む。', 'One suspect on his knees. Moving to restrain. Cover.'],
];

/** 偽装投降に撃たれた */
export const RESTRAIN_FAKE: readonly RadioLine[] = [
  ['投降は偽装だ！武器を持っている！', 'It was a fake surrender! He has a weapon!'],
  ['撃たれた！偽装投降だ！', 'Shots! He faked it!'],
];

/** 拘束完了（容疑者モード）。CUFF と別プール: 武器の押収は言わない */
export const RESTRAIN_DONE: readonly RadioLine[] = [
  ['拘束した。次へ進む。', 'Suspect cuffed. Moving on.'],
  ['容疑者を拘束。クリア、続行する。', 'He is in cuffs. Continuing the sweep.'],
];

/** 見えない位置から撃たれた: 射手の位置と開口を全隊に共有（ホットスポット） */
export const HOT_SPOT_DOOR: readonly RadioLine[] = [
  ['ドアの隙間から撃たれた！あの隙間は覗くな！', 'Shot through the door gap! Do not peek it!'],
  ['{room}のドアだ！隙間から撃ってくる、気を付けろ！', 'Shooter behind the {roomEn} door! He is firing through the gap!'],
];
export const HOT_SPOT_STAIR: readonly RadioLine[] = [
  ['階段の上から撃たれた！階段は盾が先頭だ！', 'Shot from the stairwell! Shield leads on the stairs!'],
  ['階段室に潜んでいる！直接上るな！', 'He is in the stairwell! Do not climb blind!'],
];
export const HOT_SPOT_WINDOW: readonly RadioLine[] = [
  ['窓口から撃たれた！あそこに潜んでいる！', 'Shot through the window opening! He is right there!'],
  ['室内の窓口だ！狙われている、覗くな！', 'Pass-through window! He is covering it!'],
];
export const HOT_SPOT_OPEN: readonly RadioLine[] = [
  ['見えない位置から撃たれた！{room}だ、警戒しろ！', 'Shot from an angle we cannot see! {roomEn}, watch it!'],
];
export const HOT_PREAIM: readonly RadioLine[] = [
  ['隙間に照準を合わせたまま進め！', 'Keep your sights on the gap as you move!'],
  ['パイを切って進む。隙間から目を離すな。', 'Slice the pie. Eyes on the gap.'],
];
export const HOT_SUPPRESS: readonly RadioLine[] = [
  ['制圧射撃！ドアの隙間を撃ち込め！', 'Suppressing fire on the gap!'],
  ['隙間に撃ち込んで頭を下げさせろ！', 'Hammer the gap. Keep his head down!'],
];
export const HOT_SHIELD: readonly RadioLine[] = [
  ['盾が先頭、全員その後ろにスタック！', 'Shield up front. Everyone stack behind him!'],
  ['盾持ちが前へ。続け、後ろから援護。', 'Shield first. Stay behind him and cover.'],
];
export const HOT_STAIR_FLASH: readonly RadioLine[] = [
  ['階段室へ閃光弾を投げ込む！上る前に目を潰せ！', 'Flashing the stairwell before we climb!'],
  ['閃光弾を階段へ！爆発するまで上るな！', 'Bang up the stairs! Hold until it pops!'],
];
export const HOT_KICK: readonly RadioLine[] = [
  ['半開きのドアだ。蹴り開ける、警戒！', 'Door cracked open. Kicking it wide, cover!'],
];

export const CIVILIAN_SECURE: readonly RadioLine[] = [
  ['民間人を確保した。', 'Civilian secure.'],
  ['民間人は安全だ。', 'Civilian is safe.'],
  ['人質を確保。怪我はない。', 'Hostage secure. No injuries.'],
];

export const WEAPON_SECURE: readonly RadioLine[] = [
  ['証拠の武器を回収した。', 'Weapon secured.'],
  ['落ちている武器を押収した。', 'We have the weapon.'],
  ['武器を確保した。', 'Weapon is secure.'],
];

export const AREA_SECURE: readonly RadioLine[] = [
  ['脅威は制圧した。残りの確保に入る。', 'Threats are down. Securing the rest.'],
  ['エリアは安全。拘束と保護を続ける。', 'Area is secure. Cuffing and escorting.'],
  ['戦闘終了。容疑者と民間人を確保する。', 'All clear. Moving to secure suspects and civilians.'],
];

export const RUSH_BLIND: readonly RadioLine[] = [
  ['フラッシュが効いた！今のうちに詰めろ！', 'He is flashed! Push in now!'],
  ['目が見えていない！行け！', 'Suspect is blind! Go, go!'],
];

export const RUSH_RELOAD: readonly RadioLine[] = [
  ['リロードしている！撃ち切る前に行け！', 'He is reloading! Move in!'],
  ['弾を込めている音だ。詰めろ！', 'Reload sound. Push him!'],
];

export const RUSH_PEPPER: readonly RadioLine[] = [
  ['非致死が効いている。距離を詰めろ！', 'Less-lethal hit. Close the distance!'],
  ['ペッパーが入った。押さえに行け！', 'Pepper is on him. Move in!'],
];

export const RUSH_WOUNDED: readonly RadioLine[] = [
  ['容疑者は負傷している。制圧しろ！', 'Suspect is wounded. Press him!'],
  ['撃たれている。今だ、行け！', 'He is hit. Move in and secure!'],
];

export const RUSH_BY_REASON = {
  blind: RUSH_BLIND,
  reload: RUSH_RELOAD,
  pepper: RUSH_PEPPER,
  lowHp: RUSH_WOUNDED,
} as const;

export const NOISE_GUN: readonly RadioLine[] = [
  ['発砲音！音の方向へ前進する。', 'Shots fired. Moving to the sound.'],
  ['銃声を確認。そちらへ向かう。', 'Gunfire. We are moving to it.'],
  ['撃っている。音の方を調べる。', 'Shots. Checking the direction.'],
];

export const NOISE_STEP: readonly RadioLine[] = [
  ['足音を確認。調べる。', 'Footsteps. Checking it out.'],
  ['誰かの足音だ。向かう。', 'Movement. We are checking.'],
  ['足音がした。確認に行く。', 'Heard footsteps. Moving to check.'],
];

export const NOISE_DOOR: readonly RadioLine[] = [
  ['ドアの音がした。確認に向かう。', 'Heard a door. Moving to check.'],
  ['扉が動いた。見に行く。', 'Door noise. Checking it.'],
  ['ドアの音を確認。そちらへ。', 'A door just moved. On our way.'],
];

export const NOISE_VOICE: readonly RadioLine[] = [
  ['咳き込む声が聞こえた。その部屋を確認する。', 'Coughing. Checking that room.'],
  ['人の声だ。部屋を特定して向かう。', 'Heard someone. Moving to that room.'],
];

export const NOISE_BY_KIND: Record<string, readonly RadioLine[]> = {
  gunshot: NOISE_GUN,
  footstep: NOISE_STEP,
  door: NOISE_DOOR,
  voice: NOISE_VOICE,
};

export const PRESS_2: readonly RadioLine[] = [
  ['時間をかけるな。距離を詰めろ。', 'Do not linger. Push in.'],
  ['テンポを上げろ。押せ。', 'Pick up the pace. Move in.'],
];

export const PRESS_3: readonly RadioLine[] = [
  ['容疑者は追い詰められている。一気に制圧する。', 'He is cornered. Press the attack.'],
  ['逃げ場はない。押さえろ。', 'Nowhere to run. Take him.'],
];

export const PRESS_4: readonly RadioLine[] = [
  ['全員突っ込め。逃がすな。', 'All units, press. Do not let him breathe.'],
  ['総員、前進。ここで終わらせろ。', 'All units, move in. Finish it.'],
];

export const PRESS_BY_STEP: Record<number, readonly RadioLine[]> = {
  2: PRESS_2,
  3: PRESS_3,
  4: PRESS_4,
};

const REINFORCE: readonly RadioLine[] = [
  ['増援、{cell}班。外周から突入する。', 'Reinforcements. {cell} is making entry.'],
  ['{cell}班が増援だ。突入する。', '{cell} reinforcements, moving in.'],
];

const RESCAN_LINES: readonly RadioLine[] = [
  ['全区を見たが容疑者はいない。再捜索する。', 'Nobody found. Searching again.'],
  ['見終わったが、まだどこかにいるはずだ。もう一度見る。', 'Sweep is done. He is still out there. Going back.'],
];

const DUG_IN_GAS: readonly RadioLine[] = [
  ['{room}に籠もっている。催涙ガスを撃ち込む。', 'Suspect is dug in at {roomEn}. Deploying CS gas.'],
  ['{room}から出てこない。CSガスを入れる。', 'He is still in {roomEn}. CS gas out.'],
];

export const BARRICADE: readonly RadioLine[] = [
  ['窓にバリケードだ。撃ち抜いて射線を開く。', 'Window is boarded. Shooting it out.'],
  ['板で塞がれている。射線を作る。', 'Boards on the window. Opening a lane.'],
];

export const TRAP_SPOT: readonly RadioLine[] = [
  ['ワイヤーだ。ドアにブービートラップ。解除する、時間をくれ。', 'Tripwire. Door is rigged. Stand by.'],
  ['ドアに仕掛けがある。解除中。近づくな。', 'Trap on the door. Disarming. Stay back.'],
];

export const TRAP_CLEAR: readonly RadioLine[] = [
  ['トラップ解除完了。前進する。', 'Trap disarmed. Moving.'],
  ['仕掛けは外した。進む。', 'Door is clear. Moving up.'],
];

export const TRAP_FAIL: readonly RadioLine[] = [
  ['解除に失敗した！', 'Disarm failed!'],
  ['外せない！離れろ！', 'It is live! Get back!'],
];

export const BLAST_DOWN: readonly RadioLine[] = [
  ['爆発物だ！負傷者が出た。ドアに気を付けろ。', 'IED! Officers down! Watch the doors!'],
  ['ブービーが炸裂。隊員が倒れた。ドアを警戒。', 'Booby trap detonated. Man down. Watch the doors!'],
];

export const BLAST_WARN: readonly RadioLine[] = [
  ['爆発！ブービートラップだ。全員、ドアを警戒しろ。', 'IED! Booby trap! Watch the doors!'],
  ['ドアが炸裂した。他の扉も疑え。', 'A door just blew. Treat every door as rigged!'],
];

/** Z で未確認のドアに整列だけ行うときの申告 */
export const UNSCOUTED_ROOM: readonly RadioLine[] = [
  ['向こう側は未確認です。', 'Room behind is unknown.'],
  ['中の状況が分かりません。確認が必要です。', 'No eyes on the room. Need a recon.'],
  ['室内は未確認。このまま入るのは危険です。', 'Room is unconfirmed. Going in blind is risky.'],
];

/** ミラー確認の開始 */
export const MIRROR_START: readonly RadioLine[] = [
  ['ミラーでドア下を確認する。', 'Mirroring under the door.'],
  ['ワンドを差し込む。少し待て。', 'Wand going under. Hold on.'],
  ['ドアの下から中を見る。', 'Checking under the door.'],
];

/** ドアチェック（施錠・トラップ確認）の開始 */
export const CHECK_START: readonly RadioLine[] = [
  ['ドアを確認する。ワイヤーと鍵だ。', 'Checking the door. Wire and lock.'],
  ['ノブとドア枠を見る。少し待て。', 'Checking the knob and frame. Hold.'],
  ['ドア際で確認する。罠がないか見る。', 'Going to the door edge. Checking for traps.'],
];

/** ドアチェックの結果（施錠 × トラップ）。{lock}/{trap} は日本語 / lockEn/trapEn は英語 */
export const CHECK_RESULT: readonly RadioLine[] = [
  ['{lock}。{trap}。', '{lockEn}. {trapEn}.'],
  ['確認した。{lock}、{trap}。', 'Checked. {lockEn}, {trapEn}.'],
];

export function checkResultLine(locked: boolean, trapFound: boolean): RadioLine {
  return pickRadio(CHECK_RESULT, {
    lock: locked ? '施錠' : '未施錠',
    lockEn: locked ? 'Door is locked' : 'Door is unlocked',
    trap: trapFound ? 'トラップ有り' : 'トラップ無し',
    trapEn: trapFound ? 'Trap detected' : 'No trap',
  });
}

/** トラップ解除の開始（確認済み） */
export const DISARM_START: readonly RadioLine[] = [
  ['トラップを解除する。全員離れていろ。', 'Disarming the trap. Everyone back.'],
  ['ワイヤーを外す。静かに。', 'Pulling the wire. Quiet.'],
];

/** CS ガス投入後、全員がマスクを着けて待つ */
export const GAS_MASK: readonly RadioLine[] = [
  ['ガスを入れた。マスク装着、室内に満ちるのを待つ。', 'Gas is in. Masks on, letting it fill.'],
  ['CS投入。マスクを着けて待て。', 'CS deployed. Mask up and wait.'],
];

export const RESCAN = RESCAN_LINES;

export {
  ASSAULT_GO,
  STACK_SPLIT,
  STACK_FRONT,
  CONTACT,
  RELOAD,
  FLASH,
  GAS,
  ACK_MOVE,
  ACK_OVERWATCH,
  ACK_RESTRAIN,
  ACK_RESTRAIN_SEARCH,
  ACK_HOLD,
  ACK_FOLLOW,
};
