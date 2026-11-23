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

// ---------- SPEC.md section 3: a file as lines ----------

interface FileModel {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const body = final ? text.slice(0, -br.length) : text;
  return { lines: body.split(br), br, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

// ---------- SPEC.md section 5: matching lines ----------

const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const bothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function occurrencesAt(file: string[], o: string[], tier: number): number[] {
  const norm = tier === 0 ? (s: string): string => s : tier === 1 ? trailWs : bothWs;
  const want = o.map(norm);
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (norm(file[i + j] as string) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  occ: number[];
}

function findTier(file: string[], o: string[], strict: boolean): TierHit | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const occ = occurrencesAt(file, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One body line of a unified hunk, SEARCH/REPLACE block or V4A chunk. `noNl` is set when a `\` line follows it. */
interface BodyLine {
  kind: ' ' | '-' | '+';
  text: string;
  noNl: boolean;
}

/** Build the replacement lines for a match at `at`: context lines are the file's own lines, `+` lines are the
 * patch's (re-indented at tier 2). */
function buildReplacement(items: BodyLine[], file: string[], at: number, tier: number): string[] {
  const oFirst = items.find((it) => it.kind === ' ' || it.kind === '-');
  const p = oFirst === undefined ? '' : leadWs(oFirst.text);
  const f = at < file.length ? leadWs(file[at] as string) : '';
  const out: string[] = [];
  let oIdx = 0;
  for (const it of items) {
    if (it.kind === ' ') {
      out.push(file[at + oIdx] as string);
      oIdx += 1;
    } else if (it.kind === '-') {
      oIdx += 1;
    } else {
      let t = it.text;
      if (tier === 2 && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. `origin`
 * maps a path that arrived by a move edit to the path it came from, so the output can print `R old -> new`. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly origin = new Map<string, string>();
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
  snapshot(): { now: Map<string, string | null>; origin: Map<string, string> } {
    return { now: new Map(this.now), origin: new Map(this.origin) };
  }
  restore(s: { now: Map<string, string | null>; origin: Map<string, string> }): void {
    this.now.clear();
    for (const [k, v] of s.now) this.now.set(k, v);
    this.origin.clear();
    for (const [k, v] of s.origin) this.origin.set(k, v);
  }
  create(p: string, content: string): void {
    this.now.set(p, content);
    this.origin.delete(p);
  }
  remove(p: string): void {
    this.now.set(p, null);
    this.origin.delete(p);
  }
  move(oldP: string, newP: string, content: string): void {
    this.now.set(oldP, null);
    this.now.set(newP, content);
    this.origin.set(newP, this.origin.get(oldP) ?? oldP);
    this.origin.delete(oldP);
  }
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

// ---------- SPEC.md section 6: unified diffs ----------

interface Hunk {
  a: number;
  items: BodyLine[];
}

interface UniSection {
  diffOld: string | undefined;
  diffNew: string | undefined;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renFrom: string | undefined;
  renTo: string | undefined;
  newMode: boolean;
  delMode: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: text after the four characters, up to the first tab, trimmed; a leading
 * `a/` or `b/` removed; `/dev/null` means no file. */
function uniPath(line: string): string | null {
  const t = (line.slice(4).split('\t')[0] as string).trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

function applyHunks(content: string, hunks: Hunk[], strict: boolean, path: string): string {
  const model = splitFile(content);
  let d = 0;
  for (const h of hunks) {
    const oTexts = h.items.filter((it) => it.kind === ' ' || it.kind === '-').map((it) => it.text);
    if (oTexts.length === 0) {
      const nTexts = h.items.filter((it) => it.kind === '+').map((it) => it.text);
      const oldLen = model.lines.length;
      const at = Math.min(Math.max(h.a + d, 0), oldLen);
      model.lines.splice(at, 0, ...nTexts);
      if (at === oldLen && nTexts.length > 0) {
        const lastPlus = [...h.items].reverse().find((it) => it.kind === '+');
        model.final = lastPlus === undefined ? model.final : !lastPlus.noNl;
      }
      d += nTexts.length;
    } else {
      const hit = findTier(model.lines, oTexts, strict);
      if (hit === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let at = hit.occ[0] as number;
      let bestDist = Math.abs(at - target);
      for (const pos of hit.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          at = pos;
          bestDist = dist;
        }
      }
      const replacement = buildReplacement(h.items, model.lines, at, hit.tier);
      const runsToEnd = at + oTexts.length === model.lines.length;
      const lastN = [...h.items].reverse().find((it) => it.kind === ' ' || it.kind === '+');
      model.lines.splice(at, oTexts.length, ...replacement);
      if (runsToEnd) model.final = lastN === undefined ? true : !lastN.noNl;
      d += replacement.length - oTexts.length;
    }
  }
  return joinFile(model);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)$/;
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.startsWith('diff --git ')) {
      const m = diffRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = {
        diffOld: m[1] as string,
        diffNew: m[2] as string,
        pairOld: undefined,
        pairNew: undefined,
        renFrom: undefined,
        renTo: undefined,
        newMode: false,
        delMode: false,
        hunks: [],
      };
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && cur.pairOld === undefined) {
        cur.pairOld = uniPath(line);
        cur.pairNew = uniPath(lines[i + 1] as string);
        i += 2;
        continue;
      }
      cur = {
        diffOld: undefined,
        diffNew: undefined,
        pairOld: uniPath(line),
        pairNew: uniPath(lines[i + 1] as string),
        renFrom: undefined,
        renTo: undefined,
        newMode: false,
        delMode: false,
        hunks: [],
      };
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i += 1;
      const items: BodyLine[] = [];
      while (i < lines.length) {
        const b = lines[i] as string;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith('\\')) {
          const prev = items[items.length - 1];
          if (prev !== undefined) prev.noNl = true;
          i += 1;
        } else if (b === '') {
          items.push({ kind: ' ', text: '', noNl: false });
          i += 1;
        } else if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          items.push({ kind: b[0] as ' ' | '-' | '+', text: b.slice(1), noNl: false });
          i += 1;
        } else {
          break;
        }
      }
      while (items.length > 0) {
        const last = items[items.length - 1] as BodyLine;
        if (last.kind === ' ' && last.text === '' && !last.noNl) items.pop();
        else break;
      }
      cur.hunks.push({ a, items });
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        cur.pairNew = uniPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newMode = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.delMode = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((sec) => {
    const oldPath = sec.pairOld !== undefined ? sec.pairOld : sec.renFrom !== undefined ? sec.renFrom : sec.diffOld;
    const newPath = sec.pairNew !== undefined ? sec.pairNew : sec.renTo !== undefined ? sec.renTo : sec.diffNew;
    let kind: 'create' | 'delete' | 'move' | 'change';
    if ((sec.newMode || oldPath === null) && newPath !== null && newPath !== undefined) kind = 'create';
    else if ((sec.delMode || newPath === null) && oldPath !== null && oldPath !== undefined) kind = 'delete';
    else if (oldPath !== null && oldPath !== undefined && newPath !== null && newPath !== undefined && oldPath !== newPath) kind = 'move';
    else kind = 'change';
    return (tree: Tree): void => {
      if (kind === 'create') {
        const p = newPath as string;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: BodyLine[] = [];
        for (const h of sec.hunks) for (const it of h.items) if (it.kind === '+') plus.push(it);
        const text = plus.length === 0 ? '' : plus.map((it) => it.text).join('\n') + (plus[plus.length - 1]!.noNl ? '' : '\n');
        tree.create(p, text);
        return;
      }
      if (kind === 'delete') {
        const p = oldPath as string;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.remove(p);
        return;
      }
      if (kind === 'move') {
        const op = oldPath as string;
        const np = newPath as string;
        if (!safe(op)) throw new Fail('unsafe', op);
        if (!safe(np)) throw new Fail('unsafe', np);
        const content = tree.get(op);
        if (content === null) throw new Fail('missing', op);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        tree.move(op, np, applyHunks(content, sec.hunks, strict, op));
        return;
      }
      const p = (oldPath ?? '') as string;
      if (!safe(p)) throw new Fail('unsafe', p);
      const content = tree.get(p);
      if (content === null) throw new Fail('missing', p);
      tree.now.set(p, applyHunks(content, sec.hunks, strict, p));
    };
  });
}

// ---------- SPEC.md section 7: SEARCH/REPLACE blocks ----------

interface SrBlock {
  path: string;
  old: string[];
  nw: string[];
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.trimEnd() === '<<<<<<< SEARCH') {
      const s = i;
      let path: string | null = null;
      for (let j = s - 1; j > prevReplaceEnd; j--) {
        const cand = lines[j] as string;
        if (cand.trim() === '') continue;
        if (cand.trim().startsWith('```')) continue;
        path = cand.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
        path = prevPath;
      }
      let eq = -1;
      let k = s + 1;
      for (; k < lines.length; k++) {
        const l = lines[k] as string;
        if (l.trimEnd() === '=======') {
          eq = k;
          break;
        }
        if (l.trimEnd() === '>>>>>>> REPLACE' || l.trimEnd() === '<<<<<<< SEARCH') break;
      }
      if (eq === -1) throw new Exit2(`error: parse ${s + 1}`);
      let rep = -1;
      for (k = eq + 1; k < lines.length; k++) {
        const l = lines[k] as string;
        if (l.trimEnd() === '>>>>>>> REPLACE') {
          rep = k;
          break;
        }
        if (l.trimEnd() === '<<<<<<< SEARCH') break;
      }
      if (rep === -1) throw new Exit2(`error: parse ${s + 1}`);
      blocks.push({ path, old: lines.slice(s + 1, eq), nw: lines.slice(eq + 1, rep) });
      prevPath = path;
      prevReplaceEnd = rep;
      i = rep + 1;
    } else {
      i += 1;
    }
  }
  return blocks.map((b) => {
    return (tree: Tree): void => {
      const p = b.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (b.old.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.create(p, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
        return;
      }
      const content = tree.get(p);
      if (content === null) throw new Fail('missing', p);
      const model = splitFile(content);
      const hit = findTier(model.lines, b.old, strict);
      if (hit === null) throw new Fail('no-match', p);
      if (hit.occ.length > 1) throw new Fail('ambiguous', p);
      const at = hit.occ[0] as number;
      const items: BodyLine[] = [
        ...b.old.map((t): BodyLine => ({ kind: '-', text: t, noNl: false })),
        ...b.nw.map((t): BodyLine => ({ kind: '+', text: t, noNl: false })),
      ];
      const replacement = buildReplacement(items, model.lines, at, hit.tier);
      model.lines.splice(at, b.old.length, ...replacement);
      tree.now.set(p, joinFile(model));
    };
  });
}

// ---------- SPEC.md section 8: V4A patches ----------

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyLine[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: V4aChunk[];
  updateLine: number;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if ((lines[first] as string).trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k] as string)) {
      last = k;
      break;
    }
  }
  if ((lines[last] as string).trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i] as string;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let sec: V4aSection | null = null;
    if (line.startsWith('*** Add File:')) {
      sec = { kind: 'add', path: line.slice('*** Add File:'.length).trim(), moveTo: null, addLines: [], chunks: [], updateLine: 0 };
    } else if (line.startsWith('*** Delete File:')) {
      sec = { kind: 'delete', path: line.slice('*** Delete File:'.length).trim(), moveTo: null, addLines: [], chunks: [], updateLine: 0 };
    } else if (line.startsWith('*** Update File:')) {
      sec = { kind: 'update', path: line.slice('*** Update File:'.length).trim(), moveTo: null, addLines: [], chunks: [], updateLine: i + 1 };
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    sections.push(sec);
    i += 1;
    const raw: { text: string; num: number }[] = [];
    while (i < last) {
      const l = lines[i] as string;
      if (l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:')) break;
      raw.push({ text: l, num: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (sec.kind === 'add') {
      for (const r of raw) {
        if (r.text === '') sec.addLines.push('');
        else if (r.text.startsWith('+')) sec.addLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.num}`);
      }
    } else if (sec.kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.num}`);
    } else {
      let idx = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to:')) {
        sec.moveTo = raw[0]!.text.slice('*** Move to:'.length).trim();
        idx = 1;
      }
      let curChunk: V4aChunk | null = null;
      for (; idx < raw.length; idx++) {
        const r = raw[idx] as { text: string; num: number };
        const l = r.text;
        if (l.trimEnd() === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${r.num}`);
          curChunk.eof = true;
          curChunk = null;
          continue;
        }
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          curChunk = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
          sec.chunks.push(curChunk);
          continue;
        }
        if (l.startsWith('*** Move to:')) throw new Exit2(`error: parse ${r.num}`);
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (curChunk === null) {
            if (sec.chunks.length > 0) throw new Exit2(`error: parse ${r.num}`);
            curChunk = { anchor: null, eof: false, items: [] };
            sec.chunks.push(curChunk);
          }
          if (l === '') curChunk.items.push({ kind: ' ', text: '', noNl: false });
          else curChunk.items.push({ kind: l[0] as ' ' | '-' | '+', text: l.slice(1), noNl: false });
          continue;
        }
        throw new Exit2(`error: parse ${r.num}`);
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.updateLine}`);
    }
  }
  return sections.map((sec) => {
    return (tree: Tree): void => {
      if (sec.kind === 'add') {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        tree.create(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
        return;
      }
      if (sec.kind === 'delete') {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.remove(sec.path);
        return;
      }
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      const content = tree.get(sec.path);
      if (content === null) throw new Fail('missing', sec.path);
      if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
      const model = splitFile(content);
      let cursor = 0;
      for (const ch of sec.chunks) {
        if (ch.anchor !== null) {
          const a = ch.anchor;
          let found = -1;
          const top = strict ? 0 : 2;
          for (let t = 0; t <= top && found < 0; t++) {
            const norm = t === 0 ? (s: string): string => s : t === 1 ? trailWs : bothWs;
            const want = norm(a);
            for (let j = cursor; j < model.lines.length; j++) {
              if (norm(model.lines[j] as string) === want) {
                found = j;
                break;
              }
            }
          }
          if (found < 0) throw new Fail('no-match', sec.path);
          cursor = found + 1;
        }
        const oTexts = ch.items.filter((it) => it.kind === ' ' || it.kind === '-').map((it) => it.text);
        if (oTexts.length === 0) {
          const nTexts = ch.items.filter((it) => it.kind === '+').map((it) => it.text);
          const at = ch.eof ? model.lines.length : cursor;
          model.lines.splice(at, 0, ...nTexts);
          cursor = at + nTexts.length;
        } else {
          let hit: TierHit | null = null;
          const top = strict ? 0 : 2;
          for (let t = 0; t <= top; t++) {
            const occ = occurrencesAt(model.lines, oTexts, t).filter((pos) => pos >= cursor);
            if (ch.eof) {
              const eofOcc = occ.filter((pos) => pos + oTexts.length === model.lines.length);
              if (eofOcc.length > 0) {
                hit = { tier: t, occ: eofOcc };
                break;
              }
            } else if (occ.length > 0) {
              hit = { tier: t, occ };
              break;
            }
          }
          if (hit === null) throw new Fail('no-match', sec.path);
          const at = hit.occ[0] as number;
          const replacement = buildReplacement(ch.items, model.lines, at, hit.tier);
          model.lines.splice(at, oTexts.length, ...replacement);
          cursor = at + replacement.length;
        }
      }
      const out = joinFile(model);
      if (sec.moveTo !== null) tree.move(sec.path, sec.moveTo, out);
      else tree.now.set(sec.path, out);
    };
  });
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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const snap = tree.snapshot();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.restore(snap);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    if (tree.original(p) !== tree.now.get(p)) changed.push(p);
  }
  const changedSet = new Set(changed);
  const pairedOld = new Set<string>();
  const pairedNew = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p);
    if (was !== null || now === null) continue;
    const old = tree.origin.get(p);
    if (old === undefined || old === p) continue;
    if (tree.original(old) === null) continue;
    if (tree.now.get(old) !== null) continue;
    if (!changedSet.has(old)) continue;
    rows.push({ key: p, text: `R ${old} -> ${p}` });
    pairedOld.add(old);
    pairedNew.add(p);
  }
  for (const p of changed) {
    if (pairedOld.has(p) || pairedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p);
    if (was === null) rows.push({ key: p, text: `A ${p}` });
    else if (now === null) rows.push({ key: p, text: `D ${p}` });
    else rows.push({ key: p, text: `M ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
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
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
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
