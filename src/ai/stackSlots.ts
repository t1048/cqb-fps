/** 扉前スタックの立ち位置。Squad の private メソッドから切り出して人数ぶんの枠を検証できるようにしている。 */

export interface StackSlotPortal {
  centerX: number;
  centerZ: number;
  intoX: number;
  intoZ: number;
  axisX: number;
  axisZ: number;
  width: number;
}

export interface StackSlot {
  x: number;
  z: number;
}

/**
 * 扉の手前に count 人ぶんのスタック位置を返す。
 * 1 人は扉の左（立てなければ右、それも無理なら正面）。
 * 2 人は左右（片側しか立てなければその側の縦列）。
 * 3 人以上は同じ左右を崩さず、後方へ縦列を足す。同じ座標は返さない。
 */
export function layoutStackSlots(
  portal: StackSlotPortal,
  count: number,
  stackOffset: number,
  personalSpace: number,
  standable: (x: number, z: number) => boolean,
): StackSlot[] {
  const off = portal.width / 2 + stackOffset;
  const pt = (along: number, back: number): StackSlot => ({
    x: portal.centerX + portal.axisX * along - portal.intoX * back,
    z: portal.centerZ + portal.axisZ * along - portal.intoZ * back,
  });
  const ok = (p: StackSlot): boolean => standable(p.x, p.z);
  const pickFallback = (cands: readonly StackSlot[], lastResort: StackSlot): StackSlot => {
    for (const c of cands) {
      if (ok(c)) return c;
    }
    return lastResort;
  };

  const left1Cand = pt(-off, 0.5);
  const left1 = ok(left1Cand) ? left1Cand : pt(-off, 0.62);
  const right1Cand = pt(off, 0.5);
  const right1 = ok(right1Cand) ? right1Cand : pt(off, 0.62);
  const leftOk = ok(left1);
  const rightOk = ok(right1);
  const center1 = pickFallback([pt(0, 0.9), pt(0, 0.65), pt(0, 1.25), pt(0, 0.45)], pt(0, 0.65));

  const n = Math.max(1, Math.floor(count));
  if (n <= 1) {
    if (leftOk) return [left1];
    if (rightOk) return [right1];
    return [center1];
  }

  const chosen: StackSlot[] = [];
  if (leftOk && rightOk) {
    chosen.push(left1, right1);
  } else if (leftOk) {
    chosen.push(left1, pickFallback([pt(-off - 0.88, 0.62), pt(-off, 1.38), pt(-off * 0.4, 1.25), center1], left1));
  } else if (rightOk) {
    chosen.push(right1, pickFallback([pt(off + 0.88, 0.62), pt(off, 1.38), pt(off * 0.4, 1.25), center1], right1));
  } else {
    chosen.push(center1, pickFallback([pt(0, 1.65), pt(0, 1.3), center1], center1));
  }

  // 固定位置フェーズの分離閾値は FIXED_OVERLAP (0.42m)。壁際にコンパクトに詰めつつ重なりを防ぐ間隔。
  const gap = Math.max(personalSpace + 0.2, 0.88);
  const minSep = Math.max(personalSpace, 0.68);
  const separated = (p: StackSlot, min: number): boolean =>
    chosen.every((c) => Math.hypot(p.x - c.x, p.z - c.z) >= min - 1e-3);

  if (chosen.length >= 2 && Math.hypot(chosen[0]!.x - chosen[1]!.x, chosen[0]!.z - chosen[1]!.z) < minSep - 1e-3) {
    chosen.pop();
  }
  if (chosen.length > n) return chosen.slice(0, n);

  const sideOrder = (index: number): Array<-1 | 1 | 0> => {
    if (leftOk && rightOk) {
      const primary: -1 | 1 = index % 2 === 0 ? -1 : 1;
      return [primary, primary === -1 ? 1 : -1, 0];
    }
    if (leftOk) return [-1, 0, 1];
    if (rightOk) return [1, 0, -1];
    return [0, -1, 1];
  };

  const maxStep = Math.ceil((n * gap) / 0.25) + 4;
  while (chosen.length < n) {
    const cands: StackSlot[] = [];
    for (const sign of sideOrder(chosen.length)) {
      if (sign !== 0) {
        // 壁沿いカバー優先（ドア射線外）。back は 1 列目 (0.50/0.62) より大きくして rank=0 先頭を保証
        for (let step = 1; step <= 4; step++) {
          cands.push(pt(sign * (off + step * 0.45), 0.64 + step * 0.08));
        }
      }
      for (let step = 1; step <= maxStep; step++) {
        const back = 0.62 + step * 0.25;
        cands.push(pt(sign * off, back));
      }
      if (sign !== 0) {
        for (let step = 1; step <= maxStep; step++) {
          const back = 0.62 + step * 0.25;
          cands.push(pt(sign * off * 0.5, back));
        }
      }
    }
    const pick = (min: number, mustStand: boolean): StackSlot | null => {
      for (const c of cands) {
        if (mustStand && !ok(c)) continue;
        if (separated(c, min)) return c;
      }
      return null;
    };
    let next = pick(gap, true) ?? pick(minSep, true) ?? pick(minSep, false);
    if (!next) {
      for (let step = 1; step <= n + 6; step++) {
        const p = pt((chosen.length % 2 === 0 ? -1 : 1) * Math.max(off * 0.35, 0.45), 0.62 + step * gap);
        if (separated(p, minSep)) {
          next = p;
          break;
        }
      }
    }
    chosen.push(next ?? pt(0, 0.62 + (chosen.length + 1) * gap));
  }
  return chosen;
}
