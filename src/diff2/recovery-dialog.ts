// Recovery / exit-TOCTOU dialogs (DIFF-EDITOR.md §3.2 / §3.2.a / §5.0.e).
//
// ResumeRecoveryModal — interrupted-session resume (§3.2, reused by §3.2.a).
// SaveToAltModal       — both vault inputs changed under the session, on `[←]`
//                        exit (§5.0.e): save the resolution under a fresh name
//                        (fail-closed on a colliding name) or discard.
//
// Both follow the proven `prompt(): Promise<choice>` pattern
// (PreSyncConflictModal): the promise resolves on `onClose`, default choice is
// "cancel", explicit button clicks overwrite it before close. MAXIMALLY COMPACT
// (fit an average phone) yet informative — short labels, no scrolling.
//
//   §3.2   ResumeRecoveryModal — interrupted session: replay-resume vs fresh.
//          [Continue editing] / [Start over] / ×(cancel).
//   §3.2.a one vault side changed under the session → the SAME modal (it is just
//          crash recovery — no scary "files changed" dialog); a "*" + footnote
//          marks the changed file, and Continue carries the user's edit for the
//          UNCHANGED side onto the new version (mechanics in the view).

import { App, Modal, normalizePath } from "obsidian";

export type ResumeChoice = "continue" | "start-over" | "cancel";

// §5.0.e both-changed save-to-alt result.
export type SaveAltChoice =
  | { choice: "save"; name: string }
  | { choice: "discard" }
  | { choice: "cancel" };

// Row-3 / case-4 — the user emptied a base file that HAD content. Three ways out:
//   - Delete file  → remove it (resolving to empty = deletion).
//   - Keep empty   → keep it as an empty file. Stored as a 1-byte "\n", NOT a
//     true 0-byte file: a 0-byte file would be resurrected by the sync engine's
//     zero-byte guard (SYNC2 §2.9), so "\n" is the agreed benign compromise.
//   - Cancel       → return to the editor (put content back).
export type EmptyDeleteChoice = "delete" | "keep" | "cancel";

export class EmptyDeleteModal extends Modal {
  private choice: EmptyDeleteChoice = "cancel";

  constructor(
    app: App,
    private readonly basePath: string,
  ) {
    super(app);
  }

  prompt(): Promise<EmptyDeleteChoice> {
    return new Promise((resolve) => {
      this.onClose = () => resolve(this.choice);
      const c = this.contentEl;
      this.titleEl.setText("File is empty");
      c.empty();

      c.createEl("p").setText(
        `You emptied "${this.basePath}". Delete the file, or keep it as an ` +
          "empty file?",
      );
      c.createEl("p", { cls: "diff2-recovery-footnote" }).setText(
        "An empty file is stored with a single newline (a true 0-byte file " +
          "would be restored on the next sync).",
      );

      const row = c.createDiv({ cls: "modal-button-container" });
      const del = row.createEl("button", {
        text: "Delete file",
        cls: "mod-warning",
      });
      del.addEventListener("click", () => {
        this.choice = "delete";
        this.close();
      });
      const keep = row.createEl("button", { text: "Keep empty", cls: "mod-cta" });
      keep.addEventListener("click", () => {
        this.choice = "keep";
        this.close();
      });
      const cancel = row.createEl("button", { text: "Cancel" });
      cancel.addEventListener("click", () => {
        this.choice = "cancel";
        this.close();
      });

      this.open();
    });
  }
}

export interface ResumeInfo {
  basePath: string;
  siblingPath: string;
  startedAtIso: string;
  editCount: number;
  // Optional "Last:" clock (last edit / cursor save). Omitted if absent.
  lastEditIso?: string;
  // Marks a side with "*" + a footnote when that vault file changed under the
  // session. §3.2.a one-side-changed recovery REUSES this modal (no separate
  // "files changed" dialog — it is just crash recovery). Both false on a plain
  // resume.
  baseChanged?: boolean;
  siblingChanged?: boolean;
  // Injected for deterministic relative-time rendering (caller: Date.now()).
  nowMs: number;
}

// "just now" / "12 minutes ago" / "2 hours ago" / "3 days ago". Pure + tested.
export function relativeTimeFromIso(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "some time ago";
  const min = Math.floor(Math.max(0, nowMs - then) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const d = Math.floor(hr / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

// "HH:MM:SS" local-clock for the "Last:" line. "" on an unparseable input.
export function clockFromIso(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// §3.2 — vault unchanged since session start. Offer replay-resume or fresh.
export class ResumeRecoveryModal extends Modal {
  private choice: ResumeChoice = "cancel";

  constructor(
    app: App,
    private readonly info: ResumeInfo,
  ) {
    super(app);
  }

  prompt(): Promise<ResumeChoice> {
    return new Promise((resolve) => {
      this.onClose = () => resolve(this.choice);
      const c = this.contentEl;
      this.titleEl.setText("Resume previous edit session?");
      c.empty();

      c.createEl("p").setText("Unfinished edit session for:");
      const star = (changed?: boolean) => (changed ? "* " : "");
      const ul = c.createEl("ul");
      ul.createEl("li").setText(
        `${star(this.info.baseChanged)}base: ${this.info.basePath}`,
      );
      ul.createEl("li").setText(
        `${star(this.info.siblingChanged)}sibling: ${this.info.siblingPath}`,
      );
      const meta =
        `Started ${relativeTimeFromIso(this.info.startedAtIso, this.info.nowMs)}` +
        ` · ${this.info.editCount} edit${this.info.editCount === 1 ? "" : "s"} saved` +
        (this.info.lastEditIso
          ? ` · last ${clockFromIso(this.info.lastEditIso)}`
          : "");
      c.createEl("p").setText(meta);
      if (this.info.baseChanged || this.info.siblingChanged) {
        c.createEl("p", { cls: "diff2-recovery-footnote" }).setText(
          "* this file changed in the vault since the last editing session.",
        );
      }

      const row = c.createDiv({ cls: "modal-button-container" });
      const cont = row.createEl("button", {
        text: "Continue editing",
        cls: "mod-cta",
      });
      cont.addEventListener("click", () => {
        this.choice = "continue";
        this.close();
      });
      const over = row.createEl("button", { text: "Start over" });
      over.addEventListener("click", () => {
        this.choice = "start-over";
        this.close();
      });
      const cancel = row.createEl("button", { text: "Cancel" });
      cancel.addEventListener("click", () => {
        this.choice = "cancel";
        this.close();
      });

      this.open();
    });
  }
}

export interface SaveAltInfo {
  // Prefill for the name box. §5.0.e seeds it with the conflict's base path so
  // the user has a sensible starting point to edit.
  defaultName: string;
  // Collision predicate (caller: vault.adapter.exists). Save is blocked on a
  // truthy result — the FAIL-CLOSED invariant "never overwrite a changed
  // original" (the prefill IS the changed original's path). Async because the
  // adapter check is.
  exists: (name: string) => Promise<boolean>;
}

// §5.0.e — BOTH inputs changed in the vault under the session. The only place
// the exit asks anything: save the resolution under a fresh name, or discard.
// An empty / colliding name keeps the modal open with an inline error (so the
// default action — un-edited Save onto the changed original — can't go through).
export class SaveToAltModal extends Modal {
  private result: SaveAltChoice = { choice: "cancel" };

  constructor(
    app: App,
    private readonly info: SaveAltInfo,
  ) {
    super(app);
  }

  prompt(): Promise<SaveAltChoice> {
    return new Promise((resolve) => {
      this.onClose = () => resolve(this.result);
      const c = this.contentEl;
      this.titleEl.setText("Saved files changed — keep your resolution?");
      c.empty();

      c.createEl("p").setText(
        "The files you were reconciling changed in the vault since you opened " +
          "them. Save your resolution under a different name, or discard it. " +
          "The changed files are left untouched.",
      );

      const input = c.createEl("input", { type: "text" });
      input.value = this.info.defaultName;
      input.style.width = "100%";

      const error = c.createEl("p", { cls: "diff2-recovery-footnote" });
      error.style.display = "none";

      const showError = (msg: string) => {
        error.setText(msg);
        error.style.display = "";
      };

      const row = c.createDiv({ cls: "modal-button-container" });
      const save = row.createEl("button", { text: "Save", cls: "mod-cta" });
      save.addEventListener("click", async () => {
        const raw = input.value.trim();
        if (!raw) {
          showError("Enter a file name.");
          return;
        }
        // normalize AFTER the empty-check (normalizePath("") → "/") so the
        // collision check and the path commitToAlt writes are the same.
        const name = normalizePath(raw);
        if (await this.info.exists(name)) {
          showError(`"${name}" already exists — choose another name.`);
          return;
        }
        this.result = { choice: "save", name };
        this.close();
      });
      const discard = row.createEl("button", { text: "Discard" });
      discard.addEventListener("click", () => {
        this.result = { choice: "discard" };
        this.close();
      });
      const cancel = row.createEl("button", { text: "Cancel" });
      cancel.addEventListener("click", () => {
        this.result = { choice: "cancel" };
        this.close();
      });

      this.open();
    });
  }
}
