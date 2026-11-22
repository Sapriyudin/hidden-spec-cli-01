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

/** A file split into lines: its line break, its lines, whether it ends with a break (SPEC §3). */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}
function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}
function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}
function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  const t = s.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}
/** Occurrences of O in F at the first tier (0..2, or 0 only when strict) with at least one (SPEC §5). */
function findOccurrences(O: string[], F: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const o = O.map((l) => normLine(l, tier));
    const pos: number[] = [];
    for (let i = 0; i + O.length <= F.length; i++) {
      let ok = true;
      for (let k = 0; k < O.length; k++) {
        if (normLine(F[i + k]!, tier) !== o[k]) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}
/** First occurrence of O at or after `from`, at the first tier with one there (SPEC §8 anchor/chunk search). */
function findFirstAtOrAfter(O: string[], F: string[], from: number, strict: boolean, eofOnly: boolean): { tier: number; pos: number } | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const o = O.map((l) => normLine(l, tier));
    for (let i = from; i + O.length <= F.length; i++) {
      if (eofOnly && i + O.length !== F.length) continue;
      let ok = true;
      for (let k = 0; k < O.length; k++) {
        if (normLine(F[i + k]!, tier) !== o[k]) {
          ok = false;
          break;
        }
      }
      if (ok) return { tier, pos: i };
    }
  }
  return null;
}
/** A line of N: text plus, for a context line, its index into O (copy the file's own line, SPEC §5). */
interface NewLine {
  text: string;
  context: number;
}
/** Replace F[pos..pos+O.length) with N, applying the tier-2 re-indentation rule (SPEC §5). */
function applyReplace(F: string[], pos: number, O: string[], N: NewLine[], tier: number): string[] {
  const out = F.slice(0, pos);
  const p = O.length > 0 ? leadWs(O[0]!) : '';
  const f0 = pos < F.length ? leadWs(F[pos]!) : '';
  for (const n of N) {
    if (n.context >= 0) out.push(F[pos + n.context]!);
    else if (tier === 2 && n.text !== '' && n.text.trim() !== '' && n.text.startsWith(p)) out.push(f0 + n.text.slice(p.length));
    else out.push(n.text);
  }
  out.push(...F.slice(pos + O.length));
  return out;
}
/** File lines from a list of lines, LF breaks, ended by a break unless empty (SPEC §3). */
function linesToText(lines: string[]): string {
  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in order, for the R output rows (SPEC §2). */
  readonly moves: Array<[string, string]> = [];
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

/** ---- Unified diffs (SPEC §6) ---- */

interface HunkBodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}
interface Hunk {
  a: number;
  body: HunkBodyLine[];
}
interface UniSection {
  oldNamed: boolean;
  oldVal: string | null;
  newNamed: boolean;
  newVal: string | null;
  renFrom: string | undefined;
  renTo: string | undefined;
  gitOld: string | undefined;
  gitNew: string | undefined;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** O = context + '-' lines, N = context + '+' lines, in body order (SPEC §6). */
function hunkON(h: Hunk): { O: string[]; N: NewLine[] } {
  const O: string[] = [];
  const N: NewLine[] = [];
  for (const b of h.body) {
    if (b.kind === ' ') {
      O.push(b.text);
      N.push({ text: b.text, context: O.length - 1 });
    } else if (b.kind === '-') O.push(b.text);
    else if (b.kind === '+') N.push({ text: b.text, context: -1 });
  }
  return { O, N };
}
/** True when a `\` line follows the hunk's last context or `+` line (SPEC §6 final-break rule). */
function backslashAfterLast(h: Hunk): boolean {
  let last = -1;
  for (let k = 0; k < h.body.length; k++) {
    if (h.body[k]!.kind === ' ' || h.body[k]!.kind === '+') last = k;
  }
  return last >= 0 && h.body[last + 1]?.kind === '\\';
}
/** A created file's text: the `+` lines of all hunks, in order (SPEC §6). */
function creationText(hunks: Hunk[]): string {
  const plus: string[] = [];
  let lastHunk: Hunk | null = null;
  let lastIdx = -1;
  for (const h of hunks) {
    for (let k = 0; k < h.body.length; k++) {
      if (h.body[k]!.kind === '+') {
        plus.push(h.body[k]!.text);
        lastHunk = h;
        lastIdx = k;
      }
    }
  }
  if (plus.length === 0) return '';
  const noBreak = lastHunk !== null && lastHunk.body[lastIdx + 1]?.kind === '\\';
  return plus.join('\n') + (noBreak ? '' : '\n');
}
/** Apply a section's hunks in order to a file's text, with drift d and the final-break rules (SPEC §6). */
function applyUniHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let cur = f.lines;
  let fin = f.final;
  let d = 0;
  for (const h of hunks) {
    const { O, N } = hunkON(h);
    const noBreak = backslashAfterLast(h);
    if (O.length === 0) {
      const idx = Math.max(0, Math.min(h.a + d, cur.length));
      const atEnd = idx === cur.length;
      cur = applyReplace(cur, idx, [], N, 0);
      if (atEnd) fin = !noBreak;
      d += N.length;
    } else {
      const found = findOccurrences(O, cur, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      for (const p of found.pos) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const runsToEnd = best + O.length === cur.length;
      cur = applyReplace(cur, best, O, N, found.tier);
      if (runsToEnd) fin = !noBreak;
      d += N.length - O.length;
    }
  }
  return joinFile({ lines: cur, br: f.br, final: fin });
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/** A `--- `/`+++ ` path: text after the four characters, up to the first tab, trimmed (SPEC §6). */
function parsePatchPath(raw: string): string | null {
  const t = raw.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

function uniSectionEdit(s: UniSection, strict: boolean): Edit {
  const oldPath = s.oldNamed ? s.oldVal : s.renFrom !== undefined ? s.renFrom : s.gitOld !== undefined ? s.gitOld : null;
  const newPath = s.newNamed ? s.newVal : s.renTo !== undefined ? s.renTo : s.gitNew !== undefined ? s.gitNew : null;
  if (s.create || oldPath === null) {
    const p = newPath ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, creationText(s.hunks));
    };
  }
  if (s.del || newPath === null) {
    const p = oldPath ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  if (oldPath !== newPath) {
    const o = oldPath ?? '';
    const n = newPath ?? '';
    return (tree) => {
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(n)) throw new Fail('unsafe', n);
      const text = tree.get(o);
      if (text === null) throw new Fail('missing', o);
      if (tree.get(n) !== null) throw new Fail('exists', n);
      const out = applyUniHunks(text, s.hunks, strict, o);
      tree.now.set(n, out);
      tree.now.set(o, null);
      tree.moves.push([o, n]);
    };
  }
  const p = oldPath ?? '';
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    tree.now.set(p, applyUniHunks(text, s.hunks, strict, p));
  };
}

/** ---- SEARCH/REPLACE blocks (SPEC §7) ---- */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= searchFrom; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    if (oldLines.length === 0) {
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, linesToText(newLines));
      });
    } else {
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const text = tree.get(p);
        if (text === null) throw new Fail('missing', p);
        const f = splitFile(text);
        const found = findOccurrences(oldLines, f.lines, strict);
        if (found === null) throw new Fail('no-match', p);
        if (found.pos.length > 1) throw new Fail('ambiguous', p);
        const n: NewLine[] = newLines.map((t) => ({ text: t, context: -1 }));
        const out = applyReplace(f.lines, found.pos[0]!, oldLines, n, found.tier);
        tree.now.set(p, joinFile({ lines: out, br: f.br, final: f.final }));
      });
    }
    prevPath = p;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  const startSection = (s: UniSection): void => {
    sections.push(s);
    cur = s;
    inHeader = true;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection({
        oldNamed: false,
        oldVal: null,
        newNamed: false,
        newVal: null,
        renFrom: undefined,
        renTo: undefined,
        gitOld: m[1],
        gitNew: m[2],
        create: false,
        del: false,
        hunks: [],
      });
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      i++;
      while (i < lines.length) {
        const l = lines[i]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
          hunk.body.push(l === '' ? { kind: ' ', text: '' } : { kind: l[0] as ' ' | '-' | '+' | '\\', text: l.slice(1) });
          i++;
        } else break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.kind === ' ' && hunk.body[hunk.body.length - 1]!.text === '') hunk.body.pop();
      cur.hunks.push(hunk);
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.oldNamed = true;
          cur.oldVal = parsePatchPath(line.slice(4));
          cur.newNamed = true;
          cur.newVal = parsePatchPath(lines[i + 1]!.slice(4));
          i += 2;
        } else {
          throw new Exit2(`error: parse ${i + 2}`);
        }
        continue;
      }
      if (line.startsWith('+++ ')) {
        cur.newNamed = true;
        cur.newVal = parsePatchPath(line.slice(4));
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renFrom = line.slice(12).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renTo = line.slice(10).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.del = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startSection({
        oldNamed: true,
        oldVal: parsePatchPath(line.slice(4)),
        newNamed: true,
        newVal: parsePatchPath(lines[i + 1]!.slice(4)),
        renFrom: undefined,
        renTo: undefined,
        gitOld: undefined,
        gitNew: undefined,
        create: false,
        del: false,
        hunks: [],
      });
      i += 2;
      continue;
    }
    i++;
  }
  return sections.map((s) => uniSectionEdit(s, strict));
}

/** ---- V4A patches (SPEC §8) ---- */

interface V4aChunk {
  anchor: string;
  body: HunkBodyLine[];
  eof: boolean;
}

function v4aChunkON(c: V4aChunk): { O: string[]; N: NewLine[] } {
  const O: string[] = [];
  const N: NewLine[] = [];
  for (const b of c.body) {
    if (b.kind === ' ') {
      O.push(b.text);
      N.push({ text: b.text, context: O.length - 1 });
    } else if (b.kind === '-') O.push(b.text);
    else if (b.kind === '+') N.push({ text: b.text, context: -1 });
  }
  return { O, N };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    const start = i + 1;
    let end = start;
    while (end < last) {
      const l = lines[end]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      end++;
    }
    const secLines: { text: string; no: number }[] = [];
    for (let k = start; k < end; k++) secLines.push({ text: lines[k]!, no: k + 1 });
    while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const sl of secLines) {
        if (sl.text === '') fileLines.push('');
        else if (sl.text.startsWith('+')) fileLines.push(sl.text.slice(1));
        else throw new Exit2(`error: parse ${sl.no}`);
      }
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, linesToText(fileLines));
      });
    } else if (kind === 'delete') {
      for (const sl of secLines) {
        if (!blank(sl.text)) throw new Exit2(`error: parse ${sl.no}`);
      }
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      let moveTo: string | null = null;
      let at = 0;
      if (secLines.length > 0 && secLines[0]!.text.startsWith('*** Move to: ')) {
        moveTo = secLines[0]!.text.slice(13).trim();
        at = 1;
      }
      const chunks: V4aChunk[] = [];
      let curChunk: V4aChunk | null = null;
      for (let k = at; k < secLines.length; k++) {
        const sl = secLines[k]!;
        const t = sl.text;
        if (t.startsWith('@@')) {
          curChunk = { anchor: t.slice(2).trim(), body: [], eof: false };
          chunks.push(curChunk);
        } else if (t.trim() === '*** End of File') {
          // Ends the open chunk and anchors it to the end of the file. With no chunk open
          // (a lone End of File line), SPEC names no error for it, so it forms an empty
          // EOF chunk, which inserts nothing: the section still counts as having a chunk.
          if (curChunk === null) {
            curChunk = { anchor: '', body: [], eof: true };
            chunks.push(curChunk);
            curChunk = null;
          } else {
            curChunk.eof = true;
            curChunk = null;
          }
        } else if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (curChunk === null) {
            if (chunks.length === 0) {
              curChunk = { anchor: '', body: [], eof: false };
              chunks.push(curChunk);
            } else {
              throw new Exit2(`error: parse ${sl.no}`);
            }
          }
          curChunk.body.push(t === '' ? { kind: ' ', text: '' } : { kind: t[0] as ' ' | '-' | '+', text: t.slice(1) });
        } else {
          throw new Exit2(`error: parse ${sl.no}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      const p = path;
      const mt = moveTo;
      const chs = chunks;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const text = tree.get(p);
        if (text === null) throw new Fail('missing', p);
        if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
        const f = splitFile(text);
        let cur2 = f.lines;
        let cursor = 0;
        for (const c of chs) {
          if (c.anchor !== '') {
            const a = findFirstAtOrAfter([c.anchor], cur2, cursor, strict, false);
            if (a === null) throw new Fail('no-match', p);
            cursor = a.pos + 1;
          }
          const { O, N } = v4aChunkON(c);
          if (O.length === 0) {
            const idx = c.eof ? cur2.length : cursor;
            cur2 = applyReplace(cur2, idx, [], N, 0);
            cursor = idx + N.length;
          } else {
            const found = findFirstAtOrAfter(O, cur2, cursor, strict, c.eof);
            if (found === null) throw new Fail('no-match', p);
            cur2 = applyReplace(cur2, found.pos, O, N, found.tier);
            cursor = found.pos + N.length;
          }
        }
        const out = joinFile({ lines: cur2, br: f.br, final: f.final });
        if (mt !== null) {
          tree.now.set(mt, out);
          tree.now.set(p, null);
          tree.moves.push([p, mt]);
        } else {
          tree.now.set(p, out);
        }
      });
    }
    i = end;
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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
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
  // Qualifying moves (SPEC §2): old existed before and not after, new did not exist before and does after.
  const rPairs: Array<[string, string]> = [];
  for (const [o, n] of tree.moves) {
    const oldWas = tree.original(o);
    const oldNow = tree.now.has(o) ? tree.now.get(o)! : tree.original(o);
    const newWas = tree.original(n);
    const newNow = tree.now.has(n) ? tree.now.get(n)! : tree.original(n);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) rPairs.push([o, n]);
  }
  const rOld = new Set(rPairs.map(([o]) => o));
  const rByNew = new Map<string, string[]>();
  for (const [o, n] of rPairs) {
    const list = rByNew.get(n) ?? [];
    list.push(o);
    rByNew.set(n, list);
  }
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rOld.has(p)) continue; // covered by the R row at the new path
    const olds = rByNew.get(p);
    if (olds !== undefined) {
      for (const o of olds) rows.push({ key: p, line: `R ${o} -> ${p}` });
    } else {
      rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    }
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
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
