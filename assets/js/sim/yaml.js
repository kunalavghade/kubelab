// A small YAML reader and writer covering what Kubernetes manifests use: maps, lists, nested
// lists of maps, block scalars (| and >), flow lists/maps, quoted strings and multi-document
// files. Pure functions, so they run in the browser and under Node.
import { CommandError } from './util.js';

const QUOTED = /^"(?:[^"\\]|\\.)*"$|^'(?:[^']|'')*'$/;

const unquote = (v) => (v.startsWith('"')
  ? JSON.parse(v.replace(/\t/g, '\\t'))
  : v.slice(1, -1).replace(/''/g, "'"));

/** Splits "a, [b, c], {d: e}" on top-level commas only. */
const splitFlow = (body) => {
  const parts = [];
  let depth = 0, quote = null, cur = '';
  for (const ch of body) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
};

export const scalar = (raw) => {
  const v = raw.trim();
  if (QUOTED.test(v)) return unquote(v);
  if (v.startsWith('[') && v.endsWith(']')) return splitFlow(v.slice(1, -1)).map(scalar);
  if (v.startsWith('{') && v.endsWith('}')) {
    return Object.fromEntries(splitFlow(v.slice(1, -1)).map((pair) => {
      const at = pair.search(/:(\s|$)/);
      return [unquoteKey(pair.slice(0, at)), scalar(pair.slice(at + 1))];
    }));
  }
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  if (/^(true|True|TRUE)$/.test(v)) return true;
  if (/^(false|False|FALSE)$/.test(v)) return false;
  if (v === '' || v === '~' || /^null$/i.test(v)) return null;
  return v;
};

const unquoteKey = (k) => { const t = k.trim(); return QUOTED.test(t) ? unquote(t) : t; };

// Removes a trailing " # comment" unless the # sits inside quotes.
const stripComment = (line) => {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).replace(/\s+$/, '');
  }
  return line;
};

// Finds "key: value" at the top level of a line (not inside quotes or a flow collection).
const keySplit = (text) => {
  let quote = null, depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { if (i === 0) quote = ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ':' && depth === 0 && (i + 1 === text.length || text[i + 1] === ' ')) return [text.slice(0, i), text.slice(i + 1).trim()];
  }
  return null;
};

const parseDoc = (rawLines, firstLineNo) => {
  const lines = rawLines.map((raw, n) => ({ raw, n: firstLineNo + n }))
    .map((l) => ({ ...l, text: stripComment(l.raw) }))
    .filter((l) => l.text.trim())
    .map((l) => ({ ...l, indent: l.text.search(/\S/), text: l.text.trim() }));
  let i = 0;
  const fail = (msg) => { throw new CommandError(`error: error parsing YAML: line ${lines[Math.min(i, lines.length - 1)].n}: ${msg}`, 'YAML'); };

  // Block scalars read the raw source lines that follow, keeping their inner indentation.
  const blockScalar = (style, parentIndent) => {
    const out = [];
    let blockIndent = null;
    while (i < lines.length && lines[i].indent > parentIndent) {
      const raw = lines[i].raw;
      blockIndent ??= raw.search(/\S/);
      out.push(raw.slice(blockIndent));
      i++;
    }
    const keep = style.includes('-') ? '' : '\n';
    const text = style.startsWith('>') ? out.join(' ').replace(/ ?\n ?/g, '\n') : out.join('\n');
    return `${text}${out.length ? keep : ''}`;
  };

  const value = (rest, indent) => {
    if (/^[|>][+-]?$/.test(rest)) return blockScalar(rest, indent);
    if (rest !== '') return scalar(rest);
    if (i >= lines.length) return null;
    const next = lines[i];
    if (next.indent > indent || (next.indent === indent && next.text.startsWith('-'))) return node(next.indent);
    return null;
  };

  const mapping = (indent) => {
    const obj = {};
    while (i < lines.length && lines[i].indent === indent && !/^-(\s|$)/.test(lines[i].text)) {
      const kv = keySplit(lines[i].text);
      if (!kv) fail(`could not find expected ':' in "${lines[i].text}"`);
      i++;
      obj[unquoteKey(kv[0])] = value(kv[1], indent);
    }
    return obj;
  };

  const sequence = (indent) => {
    const arr = [];
    while (i < lines.length && lines[i].indent === indent && /^-(\s|$)/.test(lines[i].text)) {
      const item = lines[i].text.replace(/^-\s*/, '');
      if (item === '') { i++; arr.push(i < lines.length && lines[i].indent > indent ? node(lines[i].indent) : null); continue; }
      const kv = QUOTED.test(item) || /^[[{]/.test(item) ? null : keySplit(item);
      if (!kv) { i++; arr.push(scalar(item)); continue; }
      // "- name: web" starts a map whose other keys sit two columns deeper.
      lines[i] = { ...lines[i], indent: indent + (lines[i].text.length - item.length), text: item };
      arr.push(mapping(lines[i].indent));
    }
    return arr;
  };

  const node = (indent) => (/^-(\s|$)/.test(lines[i].text) ? sequence(indent) : mapping(indent));
  if (!lines.length) return null;
  const doc = node(lines[0].indent);
  if (i < lines.length) fail(`unexpected indentation at "${lines[i].text}"`);
  return doc;
};

/** Parses a YAML stream ("---" separated) into an array of documents, skipping empty ones. */
export const parseYamlDocs = (text) => {
  const docs = [];
  let chunk = [], start = 1;
  const flush = () => { const d = parseDoc(chunk, start); if (d != null) docs.push(d); };
  String(text).split('\n').forEach((line, n) => {
    if (/^---\s*(#.*)?$/.test(line) || /^\.\.\.\s*$/.test(line)) { flush(); chunk = []; start = n + 2; return; }
    chunk.push(line);
  });
  flush();
  return docs;
};

export const parseYaml = (text) => parseYamlDocs(text)[0] ?? null;

// ---------- writer ----------
const NEEDS_QUOTES = /^$|^[\s]|[\s]$|^[-?:,[\]{}#&*!|>'"%@`]|: | #|^(true|false|null|yes|no|on|off|~)$|^-?\d+(\.\d+)?$/i;
const fmtScalar = (v) => {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  return NEEDS_QUOTES.test(s) ? JSON.stringify(s) : s;
};
const isEmpty = (v) => v && typeof v === 'object' && !Object.keys(v).length;

/** Serialises like kubectl -o yaml: sorted keys, lists at their key's indentation. */
export const toYaml = (value, indent = 0) => {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}[]`;
    return value.map((item) => {
      if (item && typeof item === 'object' && !isEmpty(item)) {
        const body = toYaml(item, indent + 2);
        return `${pad}- ${body.slice(indent + 2)}`;
      }
      return `${pad}- ${isEmpty(item) ? (Array.isArray(item) ? '[]' : '{}') : fmtScalar(item)}`;
    }).join('\n');
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => {
      const v = value[k];
      const key = fmtScalar(k);
      if (Array.isArray(v)) return v.length ? `${pad}${key}:\n${toYaml(v, indent)}` : `${pad}${key}: []`;
      if (v && typeof v === 'object') return isEmpty(v) ? `${pad}${key}: {}` : `${pad}${key}:\n${toYaml(v, indent + 2)}`;
      if (typeof v === 'string' && v.includes('\n')) {
        const block = v.replace(/\n$/, '').split('\n').map((l) => (l ? `${pad}  ${l}` : '')).join('\n');
        return `${pad}${key}: |${v.endsWith('\n') ? '' : '-'}\n${block}`;
      }
      return `${pad}${key}: ${fmtScalar(v)}`;
    }).join('\n');
  }
  return `${pad}${fmtScalar(value)}`;
};
