// @vitest-environment happy-dom
// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, expect, it } from "vitest";
import { ResumeRecoveryModal } from "../../src/diff2/recovery-dialog";

// Owner, 2026-10-21: in the resume dialog, a file that changed in the vault
// since the editing session is marked by a RED "*", and the footnote is red
// and ends with "!" — the plain star was easy to miss.
const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
proto.createEl ??= function (this: HTMLElement, tag: string, info?: { text?: string; cls?: string }) {
  const el = document.createElement(tag);
  if (info?.text) el.textContent = info.text;
  if (info?.cls) el.className = info.cls;
  this.appendChild(el);
  return el;
};
proto.createDiv ??= function (this: HTMLElement, info?: { cls?: string }) {
  return (this as unknown as { createEl: (t: string, i?: unknown) => HTMLElement }).createEl("div", info);
};
proto.createSpan ??= function (this: HTMLElement, info?: { cls?: string; text?: string }) {
  return (this as unknown as { createEl: (t: string, i?: unknown) => HTMLElement }).createEl("span", info);
};
proto.appendText ??= function (this: HTMLElement, t: string) {
  this.appendChild(document.createTextNode(t));
};
proto.setText ??= function (this: HTMLElement, t: string) {
  this.textContent = t;
};
proto.empty ??= function (this: HTMLElement) {
  this.replaceChildren();
};

function render(baseChanged: boolean, siblingChanged: boolean): HTMLElement {
  const m = new ResumeRecoveryModal({} as never, {
    basePath: "notes/a.md",
    siblingPath: "notes/a.conflict-from-Phone-2026-06-05T09-19-10Z.md",
    baseChanged,
    siblingChanged,
    startedAtIso: "2026-10-21T10:00:00Z",
    nowMs: Date.parse("2026-10-21T10:05:00Z"),
    editCount: 3,
  } as never);
  const content = document.createElement("div");
  Object.assign(m, { titleEl: document.createElement("div"), contentEl: content });
  void m.prompt();
  return content;
}

describe("resume dialog — a changed file stands out", () => {
  it("🔑 the changed file's '*' is a red span; the unchanged one has none", () => {
    const c = render(true, false);
    const items = Array.from(c.querySelectorAll("li"));
    expect(items[0].querySelector(".diff2-recovery-changed")?.textContent).toBe("* ");
    expect(items[0].textContent).toBe("* base: notes/a.md");
    expect(items[1].querySelector(".diff2-recovery-changed")).toBeNull();
  });

  it("🔑 the footnote is red (its class) and ends with '!'", () => {
    const c = render(false, true);
    const note = c.querySelector(".diff2-recovery-footnote");
    expect(note?.textContent).toBe("* this file changed in the vault since the last editing session!");
  });

  it("nothing changed → no footnote", () => {
    expect(render(false, false).querySelector(".diff2-recovery-footnote")).toBeNull();
  });
});
