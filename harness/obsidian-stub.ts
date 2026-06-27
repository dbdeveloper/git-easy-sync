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

// §2.2.15 toolbar — diff-toolbar.ts imports setIcon; harness needs a no-op (no real icons
// in the observation harness; the layout is what we screenshot).
export function setIcon(_el: HTMLElement, _icon: string): void {}
