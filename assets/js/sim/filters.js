// Text filters used after a pipe, on the host and inside pods: grep, head, tail, wc, sort,
// uniq, cut, awk '{print $N}', tr, base64, sed s///, jq (a small subset) and xargs-free tee.
import { CommandError } from './util.js';

const b64encode = (s) => (typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(s))) : Buffer.from(s, 'utf8').toString('base64'));
const b64decode = (s) => (typeof atob === 'function' ? decodeURIComponent(escape(atob(s.trim()))) : Buffer.from(s.trim(), 'base64').toString('utf8'));

const countArg = (args, dflt) => {
  const n = args.find((a) => /^-\d+$/.test(a));
  if (n) return Number(n.slice(1));
  const i = args.findIndex((a) => a === '-n' || a === '--lines');
  if (i >= 0) return Number(args[i + 1]);
  const eq = args.find((a) => /^--lines=\d+$/.test(a) || /^-n\d+$/.test(a));
  return eq ? Number(eq.replace(/\D+/g, '')) : dflt;
};

/** sed 's/a/b/g' on a list of lines. */
export const sedReplace = (expr, lines) => {
  const m = /^s(.)(.*?)\1(.*?)\1([gi]*)$/.exec(expr);
  if (!m) throw new CommandError(`sed: -e expression #1, char ${expr.length}: unknown command: \`${expr[0]}'`, 'SED');
  const re = new RegExp(m[2], m[4].includes('i') ? 'i' : '');
  const reAll = new RegExp(m[2], `g${m[4].includes('i') ? 'i' : ''}`);
  return lines.map((l) => l.replace(m[4].includes('g') ? reAll : re, m[3].replace(/\\\//g, '/').replace(/&/g, '$&')));
};

// jq: ".", ".a.b", ".items[]", ".items[].metadata.name", ".data | keys", "-r"
const jq = (args, lines) => {
  const raw = args.includes('-r');
  const expr = args.filter((a) => !a.startsWith('-'))[0] || '.';
  let value;
  try { value = JSON.parse(lines.join('\n')); } catch { throw new CommandError('jq: error (at <stdin>:0): Cannot parse input as JSON', 'JQ'); }
  const stages = expr.split('|').map((s) => s.trim());
  let results = [value];
  for (const stage of stages) {
    if (stage === 'keys') { results = results.map((v) => Object.keys(v || {}).sort()); continue; }
    if (stage === 'length') { results = results.map((v) => (Array.isArray(v) ? v.length : Object.keys(v || {}).length)); continue; }
    const parts = stage.replace(/^\./, '').split(/\.(?![^[]*\])/).filter(Boolean);
    for (const p of parts) {
      const m = /^([^[]*)(\[(\d*)\])?$/.exec(p);
      results = results.flatMap((v) => {
        const field = m[1] ? v?.[m[1].replace(/^"|"$/g, '')] : v;
        if (!m[2]) return [field];
        if (m[3] === '') return Array.isArray(field) ? field : Object.values(field || {});
        return [field?.[Number(m[3])]];
      });
    }
  }
  return results.flatMap((r) => (raw && typeof r === 'string' ? r.split('\n') : JSON.stringify(r ?? null, null, 2).split('\n')));
};

const FILTERS = {
  grep: (args, lines) => {
    const context = { A: 0, B: 0 };
    const rest = [];
    for (let i = 0; i < args.length; i++) {
      const m = /^-([ABC])(\d*)$/.exec(args[i]);
      if (!m) { rest.push(args[i]); continue; }
      const n = Number(m[2] || args[++i]);
      if (m[1] !== 'B') context.A = n;
      if (m[1] !== 'A') context.B = n;
    }
    const flags = rest.filter((a) => /^-[a-zA-Z]+$/.test(a)).join('');
    const pattern = rest.find((a) => !/^-[a-zA-Z]+$/.test(a)) ?? '';
    const re = new RegExp(flags.includes('w') ? `\\b${pattern}\\b` : pattern.replace(/\\\|/g, '|'), flags.includes('i') ? 'i' : '');
    const hitIdx = lines.map((l, i) => (re.test(l) !== flags.includes('v') ? i : -1)).filter((i) => i >= 0);
    if (flags.includes('c')) return [String(hitIdx.length)];
    const keep = new Set(hitIdx.flatMap((i) => Array.from({ length: context.A + context.B + 1 }, (_, k) => i - context.B + k)).filter((i) => i >= 0 && i < lines.length));
    return [...keep].sort((a, b) => a - b).map((i) => lines[i]);
  },
  head: (args, lines) => lines.slice(0, countArg(args, 10)),
  tail: (args, lines) => { const n = countArg(args, 10); return args.some((a) => /^-n\+|^\+/.test(a)) ? lines.slice(Number(String(args.find((a) => /\+\d+/.test(a))).replace(/\D/g, '')) - 1) : lines.slice(-n); },
  wc: (args, lines) => {
    const clean = lines.filter((l, i) => !(i === lines.length - 1 && l === ''));
    if (args.includes('-l')) return [String(clean.length)];
    if (args.includes('-c')) return [String(clean.join('\n').length + 1)];
    return [`${String(clean.length).padStart(7)} ${String(clean.join(' ').split(/\s+/).filter(Boolean).length).padStart(7)} ${String(clean.join('\n').length + 1).padStart(7)}`];
  },
  sort: (args, lines) => {
    const numeric = args.some((a) => /n/.test(a) && a.startsWith('-'));
    const keyIdx = args.indexOf('-k') >= 0 ? Number(args[args.indexOf('-k') + 1]) - 1 : null;
    const key = (l) => (keyIdx != null ? l.trim().split(/\s+/)[keyIdx] ?? '' : l);
    const sorted = [...lines].sort((a, b) => (numeric ? parseFloat(key(a)) - parseFloat(key(b)) : key(a).localeCompare(key(b))));
    return args.some((a) => a.startsWith('-') && a.includes('r')) ? sorted.reverse() : sorted;
  },
  uniq: (args, lines) => {
    const out = [];
    lines.forEach((l) => { if (out.at(-1)?.line !== l) out.push({ line: l, n: 1 }); else out.at(-1).n++; });
    return args.includes('-c') ? out.map((o) => `${String(o.n).padStart(7)} ${o.line}`) : out.map((o) => o.line);
  },
  cut: (args, lines) => {
    const d = (args.find((a) => a.startsWith('-d')) || '-d\t').slice(2) || args[args.indexOf('-d') + 1] || '\t';
    const f = (args.find((a) => a.startsWith('-f')) || '-f1').slice(2) || args[args.indexOf('-f') + 1];
    const fields = f.split(',').map(Number);
    return lines.map((l) => fields.map((n) => l.split(d)[n - 1] ?? '').join(d));
  },
  awk: (args, lines) => {
    const prog = args.find((a) => a.includes('print')) || '{print $0}';
    const cols = [...prog.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    const skipHeader = /NR\s*>\s*1/.test(prog);
    return lines.filter((l, i) => !(skipHeader && i === 0)).map((l) => {
      const parts = l.trim().split(/\s+/);
      return cols.map((n) => (n === 0 ? l : parts[n - 1] ?? '')).join(' ');
    });
  },
  tr: (args, lines) => {
    const [from, to = ''] = args.filter((a) => !a.startsWith('-'));
    if (args.includes('-d')) return lines.map((l) => l.split('').filter((ch) => !from.includes(ch)).join(''));
    return lines.map((l) => l.split('').map((ch) => { const i = from.indexOf(ch); return i >= 0 ? to[Math.min(i, to.length - 1)] ?? '' : ch; }).join(''));
  },
  base64: (args, lines) => {
    const text = lines.join('\n');
    if (args.includes('-d') || args.includes('--decode') || args.includes('-D')) {
      try { return b64decode(text).split('\n'); } catch { throw new CommandError('base64: invalid input', 'BASE64'); }
    }
    return [b64encode(text)];
  },
  sed: (args, lines) => sedReplace(args.filter((a) => a !== '-e' && a !== '-E')[0] || '', lines),
  jq: (args, lines) => jq(args, lines),
  cat: (args, lines) => lines,
  tee: (args, lines) => lines,
  column: (args, lines) => lines,
  less: (args, lines) => lines,
  more: (args, lines) => lines,
};

export const isFilter = (cmd) => Object.prototype.hasOwnProperty.call(FILTERS, cmd);

/** Applies a filter command to piped lines. */
export const applyFilter = (cmd, args, lines) => FILTERS[cmd](args, lines);

export { b64encode, b64decode };
