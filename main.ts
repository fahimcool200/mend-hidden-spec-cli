// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** SPEC.md section 3: a file's lines, its line break and whether it ends with one. */
function fileInfo(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}
function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** SPEC.md section 5: the three matching tiers. */
const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWS(a) === trimEndWS(b);
  return trimWS(a) === trimWS(b);
}
function occurrencesAt(O: string[], lines: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < O.length; k++) if (!lineEq(O[k]!, lines[i + k]!, tier)) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}
/** The first tier at which O occurs at least once (at or after `from`), with its positions. */
function findOccurrence(O: string[], lines: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrencesAt(O, lines, t, from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** One line of N: a context line (written as the file's own line) or a new line. */
interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}
/** Build N as it is written: context lines as the file's own matched lines, other lines re-indented at tier 2. */
function buildReplacement(O: string[], N: NLine[], fileLines: string[], at: number, tier: number): string[] {
  const out: string[] = [];
  for (const nl of N) {
    if (nl.ctx) {
      out.push(fileLines[at + nl.oIdx]!);
      continue;
    }
    if (tier === 2) {
      const F = leadWS(fileLines[at] ?? '');
      const P = leadWS(O[0] ?? '');
      const t = nl.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(P)) out.push(F + t.slice(P.length));
      else out.push(t);
    } else out.push(nl.text);
  }
  return out;
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** SPEC.md section 6: unified diffs. */
interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  backslashAfterLast: boolean;
  /** A `\` line follows the hunk's last `+` line (null: the hunk has no `+` line). */
  lastPlusBackslash: boolean | null;
}
interface USection {
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}
function diffPath(raw: string): string | null {
  const p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}
function buildHunk(a: number, body: string[]): Hunk {
  const o: string[] = [];
  const n: NLine[] = [];
  let lastCtxOrPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l.startsWith('\\')) continue;
    if (l.startsWith(' ')) {
      o.push(l.slice(1));
      n.push({ text: l.slice(1), ctx: true, oIdx: o.length - 1 });
      lastCtxOrPlus = k;
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctx: false, oIdx: -1 });
      lastCtxOrPlus = k;
      lastPlus = k;
    } else {
      o.push('');
      n.push({ text: '', ctx: true, oIdx: o.length - 1 });
      lastCtxOrPlus = k;
    }
  }
  const backslashAfterLast = lastCtxOrPlus >= 0 && body[lastCtxOrPlus + 1] !== undefined && body[lastCtxOrPlus + 1]!.startsWith('\\');
  const lastPlusBackslash = lastPlus >= 0 ? body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.startsWith('\\') : null;
  return { a, o, n, backslashAfterLast, lastPlusBackslash };
}
function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  const hunkA = (l: string): number | null => {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/.exec(l);
    return m ? parseInt(m[1]!, 10) : null;
  };
  const isBodyLine = (l: string): boolean => l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\');
  const parseHunk = (i: number, a: number): { hunk: Hunk; next: number } => {
    let j = i + 1;
    const body: string[] = [];
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      if (!isBodyLine(l)) break;
      body.push(l);
      j++;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    return { hunk: buildHunk(a, body), next: j };
  };
  let sec: USection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      sec = { oldPath: m[1]!, newPath: m[2]!, hasPair: false, creation: false, deletion: false, hunks: [] };
      sections.push(sec);
      inHeader = true;
      i++;
      continue;
    }
    const isPair = l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
    if (isPair && (sec === null || !inHeader || sec.hasPair)) {
      sec = { oldPath: null, newPath: null, hasPair: false, creation: false, deletion: false, hunks: [] };
      sections.push(sec);
      sec.oldPath = diffPath(l.slice(4));
      sec.newPath = diffPath(lines[i + 1]!.slice(4));
      sec.hasPair = true;
      inHeader = true;
      i += 2;
      continue;
    }
    if (sec === null) {
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (inHeader) {
      if (l.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        sec.oldPath = diffPath(l.slice(4));
        sec.newPath = diffPath(lines[i + 1]!.slice(4));
        sec.hasPair = true;
        i += 2;
        continue;
      }
      if (l.startsWith('+++ ')) {
        sec.newPath = diffPath(l.slice(4));
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        if (!sec.hasPair) sec.oldPath = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (!sec.hasPair) sec.newPath = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.creation = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.deletion = true;
        i++;
        continue;
      }
      if (l.startsWith('@@')) {
        const a = hunkA(l);
        if (a === null) throw new Exit2(`error: parse ${i + 1}`);
        const r = parseHunk(i, a);
        sec.hunks.push(r.hunk);
        inHeader = false;
        i = r.next;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const a = hunkA(l);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      const r = parseHunk(i, a);
      sec.hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    i++;
  }
  return sections;
}
/** Apply a section's hunks in order to a file's lines. */
function applyHunks(lines: string[], final: boolean, hunks: Hunk[], strict: boolean, path: string): { lines: string[]; final: boolean } {
  let out = [...lines];
  let fin = final;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const found = findOccurrence(h.o, out, strict);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      for (const p of found.positions) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const rep = buildReplacement(h.o, h.n, out, best, found.tier);
      const touchesEnd = best + h.o.length === out.length;
      out = [...out.slice(0, best), ...rep, ...out.slice(best + h.o.length)];
      if (touchesEnd) fin = !h.backslashAfterLast;
      d += h.n.length - h.o.length;
    } else {
      const at = Math.min(h.a + d, out.length);
      const rep = h.n.map((x) => x.text);
      const touchesEnd = at === out.length;
      out = [...out.slice(0, at), ...rep, ...out.slice(at)];
      if (touchesEnd) fin = !h.backslashAfterLast;
      d += h.n.length;
    }
  }
  return { lines: out, final: fin };
}
function unifiedSectionEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const creation = sec.creation || oldP === null;
    const deletion = !creation && (sec.deletion || newP === null);
    if (creation) {
      const target = newP ?? '';
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const nl of h.n) if (!nl.ctx) plus.push(nl.text);
      let fin = true;
      for (let k = sec.hunks.length - 1; k >= 0; k--) {
        const v = sec.hunks[k]!.lastPlusBackslash;
        if (v !== null) {
          fin = !v;
          break;
        }
      }
      tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (fin ? '\n' : ''));
      return;
    }
    if (deletion) {
      const target = oldP ?? '';
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const info = fileInfo(cur);
      const r = applyHunks(info.lines, info.final, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, joinFile(r.lines, info.br, r.final));
      tree.moves.push({ old: oldP, new: newP });
      return;
    }
    const target = oldP ?? newP ?? '';
    if (!safe(target)) throw new Fail('unsafe', target);
    const cur = tree.get(target);
    if (cur === null) throw new Fail('missing', target);
    const info = fileInfo(cur);
    const r = applyHunks(info.lines, info.final, sec.hunks, strict, target);
    tree.now.set(target, joinFile(r.lines, info.br, r.final));
  };
}
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((s) => unifiedSectionEdit(s, strict));
}

/** SPEC.md section 7: SEARCH/REPLACE blocks. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: { path: string; old: string[]; neu: string[] }[] = [];
  let i = 0;
  let prevReplace = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let path: string | null = null;
    for (let p = i - 1; p > prevReplace; p--) {
      const l = lines[p]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    blocks.push({ path, old: lines.slice(i + 1, eq), neu: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return blocks.map((b) => (tree: Tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.old.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.neu.length === 0 ? '' : b.neu.join('\n') + '\n');
      return;
    }
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const info = fileInfo(cur);
    const found = findOccurrence(b.old, info.lines, strict);
    if (!found) throw new Fail('no-match', p);
    if (found.positions.length > 1) throw new Fail('ambiguous', p);
    const at = found.positions[0]!;
    const rep = buildReplacement(b.old, b.neu.map((t) => ({ text: t, ctx: false, oIdx: -1 })), info.lines, at, found.tier);
    tree.now.set(p, joinFile([...info.lines.slice(0, at), ...rep, ...info.lines.slice(at + b.old.length)], info.br, info.final));
  });
}

/** SPEC.md section 8: V4A patches. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}
function v4aUpdateEdit(p: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const info = fileInfo(cur);
    let lines = [...info.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const max = strict ? 0 : 2;
        let foundAt = -1;
        for (let t = 0; t <= max && foundAt < 0; t++) {
          for (let k = cursor; k < lines.length; k++) {
            if (lineEq(ch.anchor, lines[k]!, t)) {
              foundAt = k;
              break;
            }
          }
        }
        if (foundAt < 0) throw new Fail('no-match', p);
        cursor = foundAt + 1;
      }
      const o: string[] = [];
      const n: NLine[] = [];
      for (const bl of ch.body) {
        if (bl.startsWith(' ')) {
          o.push(bl.slice(1));
          n.push({ text: bl.slice(1), ctx: true, oIdx: o.length - 1 });
        } else if (bl.startsWith('-')) o.push(bl.slice(1));
        else if (bl.startsWith('+')) n.push({ text: bl.slice(1), ctx: false, oIdx: -1 });
        else {
          o.push('');
          n.push({ text: '', ctx: true, oIdx: o.length - 1 });
        }
      }
      if (o.length > 0) {
        const max = strict ? 0 : 2;
        let hit: { tier: number; at: number } | null = null;
        for (let t = 0; t <= max && !hit; t++) {
          for (const at of occurrencesAt(o, lines, t, cursor)) {
            if (ch.eof && at + o.length !== lines.length) continue;
            hit = { tier: t, at };
            break;
          }
        }
        if (!hit) throw new Fail('no-match', p);
        const rep = buildReplacement(o, n, lines, hit.at, hit.tier);
        lines = [...lines.slice(0, hit.at), ...rep, ...lines.slice(hit.at + o.length)];
        cursor = hit.at + rep.length;
      } else {
        const at = ch.eof ? lines.length : cursor;
        const rep = n.map((x) => x.text);
        lines = [...lines.slice(0, at), ...rep, ...lines.slice(at)];
        cursor = at + rep.length;
      }
    }
    const text = joinFile(lines, info.br, info.final);
    if (moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(moveTo, text);
      tree.moves.push({ old: p, new: moveTo });
    } else {
      tree.now.set(p, text);
    }
  };
}
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean => l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (!isSectionStart(l)) throw new Exit2(`error: parse ${i + 1}`);
    const startNum = i + 1;
    const body: { text: string; num: number }[] = [];
    let j = i + 1;
    while (j < last && !isSectionStart(lines[j]!)) {
      body.push({ text: lines[j]!, num: j + 1 });
      j++;
    }
    while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();
    if (l.startsWith('*** Add File:')) {
      const p = l.slice('*** Add File:'.length).trim();
      const fileLines: string[] = [];
      for (const b of body) {
        if (b.text === '') fileLines.push('');
        else if (b.text.startsWith('+')) fileLines.push(b.text.slice(1));
        else throw new Exit2(`error: parse ${b.num}`);
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (l.startsWith('*** Delete File:')) {
      const p = l.slice('*** Delete File:'.length).trim();
      if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.num}`);
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      const p = l.slice('*** Update File:'.length).trim();
      let moveTo: string | null = null;
      let idx = 0;
      if (body[0] !== undefined && body[0].text.startsWith('*** Move to:')) {
        moveTo = body[0].text.slice('*** Move to:'.length).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let firstChunk = true;
      while (idx < body.length) {
        const b = body[idx]!;
        const t = b.text;
        if (t.startsWith('@@')) {
          if (cur) chunks.push(cur);
          cur = { anchor: t.slice(2).trim(), eof: false, body: [] };
          firstChunk = false;
          idx++;
          continue;
        }
        if (t.trim() === '*** End of File') {
          if (!cur) cur = { anchor: null, eof: false, body: [] };
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          firstChunk = false;
          idx++;
          continue;
        }
        if (t.startsWith(' ') || t.startsWith('-') || t.startsWith('+') || t === '') {
          if (!cur) {
            if (!firstChunk) throw new Exit2(`error: parse ${b.num}`);
            cur = { anchor: null, eof: false, body: [] };
          }
          cur.body.push(t);
          idx++;
          continue;
        }
        throw new Exit2(`error: parse ${b.num}`);
      }
      if (cur) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startNum}`);
      edits.push(v4aUpdateEdit(p, moveTo, chunks, strict));
    }
    i = j;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const consumed = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.get(m.old);
    const wasNew = tree.original(m.new);
    const nowNew = tree.get(m.new);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
      consumed.add(m.old);
      consumed.add(m.new);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const texts = rows.map((r) => r.text);
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
