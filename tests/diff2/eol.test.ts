import { describe, it, expect } from "vitest";
import {
  detectEol,
  toLf,
  restoreEol,
  commonEol,
  type EolStyle,
} from "../../src/diff2/eol";

// bug-59 — EOL handling for the diff2 model. Bytes stay raw; model strings are `\n`;
// write-back restores commonEol(baseEol, siblingEol).

const NL: Record<EolStyle, string> = { lf: "\n", crlf: "\r\n", cr: "\r" };

describe("detectEol — dominant line ending", () => {
  it("no \\r → lf", () => {
    expect(detectEol("a\nb\nc\n")).toBe("lf");
    expect(detectEol("")).toBe("lf");
    expect(detectEol("no newline at all")).toBe("lf");
  });
  it("\\r\\n → crlf", () => expect(detectEol("a\r\nb\r\n")).toBe("crlf"));
  it("rare \\n\\r (2-byte, reverse) → crlf, and toLf → single \\n (not \\n\\n)", () => {
    expect(detectEol("a\n\rb\n\r")).toBe("crlf");
    expect(toLf("a\n\rb\n\r")).toBe("a\nb\n");
  });
  it("lone \\r → cr", () => expect(detectEol("a\rb\r")).toBe("cr"));
  it("dominant wins on mixed", () => {
    expect(detectEol("a\r\nb\r\nc\n")).toBe("crlf"); // 2 crlf vs 1 lf
    expect(detectEol("a\nb\nc\r\n")).toBe("lf"); // 2 lf vs 1 crlf
  });
});

describe("toLf — any EOL → \\n", () => {
  it("crlf and lone cr both collapse to lf, no stray \\r", () => {
    expect(toLf("a\r\nb\rc\n")).toBe("a\nb\nc\n");
    expect(toLf("a\r\nb\r\n")).not.toContain("\r");
  });
  it("already-lf is unchanged", () => expect(toLf("a\nb\n")).toBe("a\nb\n"));
});

describe("restoreEol — \\n → the EOL (lf is a no-op)", () => {
  it("lf", () => expect(restoreEol("a\nb\n", "lf")).toBe("a\nb\n"));
  it("crlf", () => expect(restoreEol("a\nb\n", "crlf")).toBe("a\r\nb\r\n"));
  it("cr", () => expect(restoreEol("a\nb\n", "cr")).toBe("a\rb\r"));
});

// The user's full truth table (explicit bytes — priority LF > CR > CRLF; LF wins the tie):
//   \r\n?\r\n→\r\n · \r\n?\r→\r · \r\n?\n→\n · \r?\r→\r · \r?\n→\n · \n?\n→\n
describe("commonEol — session EOL from the two sides", () => {
  const cases: [EolStyle, EolStyle, EolStyle][] = [
    ["crlf", "crlf", "crlf"], // \r\n ? \r\n => \r\n
    ["crlf", "cr", "cr"], //     \r\n ? \r   => \r
    ["crlf", "lf", "lf"], //     \r\n ? \n   => \n
    ["cr", "cr", "cr"], //       \r   ? \r   => \r
    ["cr", "lf", "lf"], //       \r   ? \n   => \n  (LF wins the CR/LF tie)
    ["lf", "lf", "lf"], //       \n   ? \n   => \n
  ];
  for (const [a, b, want] of cases) {
    it(`${a} ? ${b} => ${want} (and symmetric)`, () => {
      expect(commonEol(a, b)).toBe(want);
      expect(commonEol(b, a)).toBe(want); // order-independent
    });
  }
});

// Round-trip "туди і назад": a base with EOL_A + a sibling with EOL_B, same text →
// normalize both to \n (model) → resolve (identical text, no spurious diff) → write-back
// with commonEol. The written bytes carry the common EOL, and the text is preserved.
describe("full EOL round-trip per (base, sibling) pair", () => {
  const styles: EolStyle[] = ["lf", "crlf", "cr"];
  for (const a of styles) {
    for (const b of styles) {
      it(`base=${a} sibling=${b} → write-back EOL = commonEol`, () => {
        const text = ["line one", "line two", "line three", ""]; // trailing EOL
        const base = text.join(NL[a]);
        const sibling = text.join(NL[b]);

        // model boundary — both normalize to \n; identical text ⇒ NO diff.
        const modelBase = toLf(base);
        const modelSibling = toLf(sibling);
        expect(modelBase).toBe(modelSibling); // EOL-only difference vanished

        // session EOL + write-back.
        const eol = commonEol(detectEol(base), detectEol(sibling));
        const resolved = modelBase; // the user "kept" this side (still \n)
        const written = restoreEol(resolved, eol);

        expect(detectEol(written)).toBe(eol);
        expect(toLf(written)).toBe(resolved); // text preserved, only EOL changed
      });
    }
  }
});
