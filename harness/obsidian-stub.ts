// Minimal "obsidian" stub for the browser-MCP harness ONLY. The diff-pane import
// graph transitively pulls modules (autosave-store, utils, atomic-write, …) that
// import from "obsidian", but NONE of their code paths run during keyboard-motion
// observation — these exports exist only so esbuild can resolve the imports.
export function normalizePath(p: string): string {
  return p;
}
export function base64ToArrayBuffer(_b: string): ArrayBuffer {
  return new ArrayBuffer(0);
}
export function arrayBufferToBase64(_b: ArrayBuffer): string {
  return "";
}
export function requestUrl(): Promise<unknown> {
  throw new Error("obsidian-stub: requestUrl not available in the harness");
}
export class TFile {}
export class TAbstractFile {}
export class Vault {}
export class DataAdapter {}
export class Notice {}
export class Modal {}
export class Setting {}
export class Scope {}
export class ItemView {}
export class WorkspaceLeaf {}
export class App {}
export type EventRef = unknown;

// §2.2.15 toolbar / marker-panel п.3 — diff-toolbar.ts + diff-pane-v2.ts import setIcon.
// The real Obsidian injects a lucide SVG. For a FAITHFUL screenshot preview (the layout AND
// the icon look are what we judge), inject the actual lucide paths for the icons the markers
// use; anything else falls back to a text token so the harness never crashes.
const LUCIDE: Record<string, string> = {
  // lucide `check`
  check: '<path d="M20 6 9 17l-5-5"/>',
  // lucide `trash-2`
  "trash-2":
    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
};
export function setIcon(el: HTMLElement, icon: string): void {
  const paths = LUCIDE[icon];
  if (!paths) {
    el.textContent = `[${icon}]`;
    return;
  }
  el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-${icon}">${paths}</svg>`;
}
