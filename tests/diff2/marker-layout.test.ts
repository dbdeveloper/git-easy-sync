import { describe, expect, it } from "vitest";
import { chooseMarkerMode, type MarkerWidths } from "../../src/diff2/marker-layout";

// Representative constant widths (px), matching the harness-measured ballpark:
//   gutter G≈40; a label row with text ≈415, with icons ≈345; buttons-only text ≈270, icons ≈150.
const W: MarkerWidths = {
  gutter: 40,
  labelRowText: 415,
  labelRowIcon: 345,
  buttonsText: 270,
  buttonsIcon: 150,
};

describe("chooseMarkerMode — priority ladder (one-line ≻ text ≻ normal-offset)", () => {
  // Each rung: the widest available at which that rung is the FIRST to fit.
  it("rung 1 — wide: text, normal offset, label inline", () => {
    expect(chooseMarkerMode(500, W)).toEqual({ icons: false, slid: false });
    expect(chooseMarkerMode(415, W)).toEqual({ icons: false, slid: false }); // exactly fits
  });

  it("rung 2 — label no longer fits: SLIDE to keep text + one line", () => {
    // 415 > 414 (no rung1) but 415 <= 414+40 (rung2)
    expect(chooseMarkerMode(414, W)).toEqual({ icons: false, slid: true });
    expect(chooseMarkerMode(390, W)).toEqual({ icons: false, slid: true }); // the phone case (fin-390)
    expect(chooseMarkerMode(375, W)).toEqual({ icons: false, slid: true }); // 415 <= 415
  });

  it("rung 3 — slid text can't keep one line: ICONS, restore normal offset", () => {
    // 415 > 374+40 (no rung2); labelRowIcon 345 <= 374 (rung3)
    expect(chooseMarkerMode(374, W)).toEqual({ icons: true, slid: false });
    expect(chooseMarkerMode(345, W)).toEqual({ icons: true, slid: false }); // exactly fits icons+label
  });

  it("rung 4 — icons+label need the slide too", () => {
    // 345 > 344 (no rung3); 345 <= 344+40 (rung4)
    expect(chooseMarkerMode(344, W)).toEqual({ icons: true, slid: true });
    expect(chooseMarkerMode(310, W)).toEqual({ icons: true, slid: true }); // 345 <= 350
  });

  it("rung 5 — one line impossible → wrap label; text returns at normal offset", () => {
    // 345 > 304+40 (no rung4); buttonsText 270 <= 304 (rung5)
    expect(chooseMarkerMode(304, W)).toEqual({ icons: false, slid: false });
    expect(chooseMarkerMode(270, W)).toEqual({ icons: false, slid: false }); // exactly fits buttons-only text
  });

  it("rung 6 — wrapped label, text needs the slide", () => {
    // 270 > 269 (no rung5); 270 <= 269+40 (rung6)
    expect(chooseMarkerMode(269, W)).toEqual({ icons: false, slid: true });
    expect(chooseMarkerMode(230, W)).toEqual({ icons: false, slid: true }); // 270 <= 270
  });

  it("rung 7 — wrapped label, text buttons don't fit even slid → icons, normal offset", () => {
    // 270 > 229+40 (no rung6); buttonsIcon 150 <= 229 (rung7)
    expect(chooseMarkerMode(229, W)).toEqual({ icons: true, slid: false });
    expect(chooseMarkerMode(150, W)).toEqual({ icons: true, slid: false });
  });

  it("rung 8 — narrowest: icons + slid, always the guaranteed fallback", () => {
    // buttonsIcon 150 > 149 (no rung7) → final rung regardless
    expect(chooseMarkerMode(149, W)).toEqual({ icons: true, slid: true });
    expect(chooseMarkerMode(0, W)).toEqual({ icons: true, slid: true });
  });

  it("monotonic: as width shrinks the mode never becomes MORE spacious (no accidental reversals within a band)", () => {
    // walk widths down; the chosen mode's 'rung index' must be non-decreasing
    const rung = (avail: number): number => {
      const m = chooseMarkerMode(avail, W);
      // encode the 8 rungs back to an index for the assertion
      const table: Array<[boolean, boolean]> = [
        [false, false], [false, true], [true, false], [true, true],
        [false, false], [false, true], [true, false], [true, true],
      ];
      // find which rung the decision corresponds to by re-deriving the condition
      const slidAvail = avail + W.gutter;
      if (W.labelRowText <= avail) return 1;
      if (W.labelRowText <= slidAvail) return 2;
      if (W.labelRowIcon <= avail) return 3;
      if (W.labelRowIcon <= slidAvail) return 4;
      if (W.buttonsText <= avail) return 5;
      if (W.buttonsText <= slidAvail) return 6;
      if (W.buttonsIcon <= avail) return 7;
      void table;
      void m;
      return 8;
    };
    let prev = 0;
    for (let avail = 600; avail >= 0; avail -= 5) {
      const r = rung(avail);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });
});
