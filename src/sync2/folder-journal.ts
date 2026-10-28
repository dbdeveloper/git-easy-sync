// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// The folder journal (GITKEEP I11-I14, I21; docs/tasks/GITKEEP.md): the
// folders worth a look at the next commit, in memory only. It is a SET,
// not an event log — the commit computes the truth for each folder, so
// the order and the number of events do not matter, and a lost journal
// (crash, dead battery) is rebuilt by the next start scan.
//
// Ancestor collapse (I14): a folder whose ancestor is already marked is
// not added; a folder that is added drops every marked descendant. So
// the set never holds an ancestor and its descendant, and the commit
// walks each subtree once. Kept as a tree of path segments, so a mark
// costs the depth of the path — not the size of the set (a copied tree
// fires one event per folder; 20 000 of them must stay cheap).

interface Node {
  marked: boolean;
  children: Map<string, Node>;
}

const newNode = (): Node => ({ marked: false, children: new Map() });

function segmentsOf(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

export default class FolderJournal {
  private root: Node = newNode();
  private count = 0;

  get size(): number {
    return this.count;
  }

  mark(path: string): void {
    const segs = segmentsOf(path);
    if (segs.length === 0) return; // the root is never a journal folder
    let node = this.root;
    for (const seg of segs) {
      if (node.marked) return; // an ancestor already covers it
      let next = node.children.get(seg);
      if (next === undefined) {
        next = newNode();
        node.children.set(seg, next);
      }
      node = next;
    }
    if (node.marked) return;
    this.count -= countMarked(node);
    node.marked = true;
    node.children = new Map(); // descendants are covered now
    this.count += 1;
  }

  // Every marked folder, without leading or trailing slash.
  *paths(): IterableIterator<string> {
    const stack: Array<[Node, string]> = [[this.root, ""]];
    while (stack.length > 0) {
      const [node, prefix] = stack.pop()!;
      if (node.marked) {
        yield prefix;
        continue;
      }
      for (const [seg, child] of node.children) {
        stack.push([child, prefix === "" ? seg : `${prefix}/${seg}`]);
      }
    }
  }

  // The commit's snapshot (I21): the marks are handed over and an EMPTY
  // journal stays behind, so a mark made while the commit runs lands in
  // the new set and is not forgotten with the snapshot.
  take(): string[] {
    const out = [...this.paths()];
    this.root = newNode();
    this.count = 0;
    return out;
  }

  // A commit that did not complete puts its snapshot back — through
  // mark(), so it collapses with whatever arrived meanwhile.
  restore(paths: Iterable<string>): void {
    for (const p of paths) this.mark(p);
  }
}

function countMarked(node: Node): number {
  let n = 0;
  const stack = [node];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur.marked) n += 1;
    for (const child of cur.children.values()) stack.push(child);
  }
  return n;
}
