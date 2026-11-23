// solve.js — a fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// My own implementation of the makefun-site spec (front matter, Markdown subset,
// template dialect, slug rule, build report), written for speed:
//  - templates are compiled to plain JS functions (new Function) once per case;
//  - a render that depends only on case-global values (site/tags/recent) is
//    computed once per case and reused; card/tag-list renders are memoised
//    per post object ("folding" the repeated fragments);
//  - slugify has an ASCII fast path plus a per-case cache (tag names and
//    titles repeat constantly);
//  - Markdown is rendered in one fused pass with chunk-wise HTML escaping,
//    never one regex replace per character;
//  - one view object per source serves both as its page and as its card,
//    so no field is ever built twice.

const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ----- text -----

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_ALL = /[&<>"']/g;
function esc(s) {
  return ESC_TEST.test(s) ? s.replace(ESC_ALL, (c) => ESC_MAP[c]) : s;
}

const SLUG_MAX = 64;
function slugifySlow(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}
const NON_ASCII = /[^\x00-\x7F]/;
function slugifyFast(text) {
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  if (e !== out.length) out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function longDate(date) {
  const y = date.slice(0, 4);
  const m = date.slice(5, 7);
  const d = date.slice(8, 10);
  return Number(d) + ' ' + MONTHS[Number(m) - 1] + ' ' + y;
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}
const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

// ----- front matter -----

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
// One "key: value" line, or null: key of [a-z_]+, ":", then either the end
// or one space and the value.
function fmLine(line) {
  let j = 0;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 97 && c <= 122) || c === 95) j++;
    else break;
  }
  if (j === 0 || line.charCodeAt(j) !== 58) return null;
  if (j + 1 === line.length) return { key: line.slice(0, j), raw: '' };
  if (line.charCodeAt(j + 1) !== 32) return null;
  let e = line.length;
  while (e > j + 2 && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return { key: line.slice(0, j), raw: line.slice(j + 2, e) };
}
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_BLANK = /^[ \t]*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function fmStringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmStringOf(raw);
      return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

// `lines` is the source split on "\n". Returns { data, close } or { error }.
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (FM_BLANK.test(line) || line.startsWith('#')) continue;
    const m = fmLine(line);
    if (m === null) return { error: 'line ' + (i + 1) + ' is not "key: value"' };
    const key = m.key;
    const raw = m.raw;
    if (FM_KEYS.indexOf(key) === -1) return { error: 'unknown key "' + key + '"' };
    if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
    if (raw === '') return { error: 'key "' + key + '" has no value' };
    const v = fmValueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, close };
}

// ----- Markdown -----

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const WS_RE = /\s/;

function isWSCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || c === 160 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
function trimST(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}
// Fence open: "```" + optional language [A-Za-z0-9_+-]* + spaces/tabs only. Returns lang or null.
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  for (let k = j; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
function headingOf(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6) return null;
  const c = line.charCodeAt(d);
  if (c !== 32 && c !== 9) return null;
  let s = d + 1;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  const text = line.slice(s, e);
  return text === '' ? null : { depth: d, text };
}
function isHR(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}
function orderedOf(line) {
  let j = 0;
  let num = 0;
  let digits = 0;
  while (j < line.length && digits < 9 && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) {
    num = num * 10 + (line.charCodeAt(j) - 48);
    j++;
    digits++;
  }
  if (digits === 0) return null;
  if (digits === 9 && j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { start: num, text: line.slice(j + 2) };
}
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let j = 2;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  return j < line.length && !isWSCode(line.charCodeAt(j));
}
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHR(line);
}

// First index >= from where `what` occurs outside a backslash escape, or -1.
function findUnescaped(s, what, from) {
  if (s.indexOf('\\', from) === -1) return s.indexOf(what, from);
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}
// First single * from `from` (one whose run is not **), outside an escape, or -1.
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

// Inline rendering: one regex-driven scan; literal runs hold no special at
// all (the regex stops at every one of them), so they go out raw.
const INLINE_RE = /[\\`*\[&<>"']/g;

function inlineInto(s, env, parts) {
  const n = s.length;
  if (n === 0) return;
  INLINE_RE.lastIndex = 0;
  let m = INLINE_RE.exec(s);
  if (m === null) {
    parts.push(s);
    return;
  }
  let lit = 0;
  let i = 0;
  while (m !== null) {
    const j = m.index;
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) {
        if (j > lit) parts.push(s.slice(lit, j));
        const e = s[j + 1];
        parts.push(e === '>' ? '&gt;' : e);
        i = j + 2;
        lit = i;
      } else {
        i = j + 1;
      }
    } else if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > lit) parts.push(s.slice(lit, j));
        parts.push('<code>', esc(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        lit = i;
      } else {
        i = j + 1;
      }
    } else if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > lit) parts.push(s.slice(lit, j));
          parts.push('<strong>');
          inlineInto(s.slice(j + 2, k), env, parts);
          parts.push('</strong>');
          i = k + 2;
          lit = i;
        } else {
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          if (j > lit) parts.push(s.slice(lit, j));
          parts.push('<em>');
          inlineInto(s.slice(j + 1, k), env, parts);
          parts.push('</em>');
          i = k + 1;
          lit = i;
        } else {
          i = j + 1;
        }
      }
    } else if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      let q = -1;
      if (k !== -1 && s[k + 1] === '(') q = s.indexOf(')', k + 2);
      const target = q === -1 ? '' : s.slice(k + 2, q);
      if (target !== '' && !WS_RE.test(target)) {
        if (j > lit) parts.push(s.slice(lit, j));
        parts.push('<a href="', esc(env.link(target)), '">');
        inlineInto(s.slice(j + 1, k), env, parts);
        parts.push('</a>');
        i = q + 1;
        lit = i;
      } else {
        i = j + 1;
      }
    } else {
      // One of & < > " ' : its entity, and the literal run ends here.
      if (j > lit) parts.push(s.slice(lit, j));
      parts.push(ESC_MAP[c]);
      i = j + 1;
      lit = i;
    }
    INLINE_RE.lastIndex = i;
    m = INLINE_RE.exec(s);
  }
  if (n > lit) parts.push(s.slice(lit, n));
}

function inline(s, env) {
  const parts = [];
  inlineInto(s, env, parts);
  return parts.length === 1 ? parts[0] : parts.join('');
}

// Words of one line: runs of characters other than whitespace.
function countWords(line) {
  let w = 0;
  let inW = false;
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13) { inW = false; continue; }
    if (c < 128) {
      if (!inW) { inW = true; w++; }
      continue;
    }
    if (isWSCode(c)) { inW = false; continue; }
    if (!inW) { inW = true; w++; }
  }
  return w;
}

// `lines` is the body split on "\n". Returns { html, toc, excerpt, words }.
// The HTML is built into one parts array and joined once.
function renderMarkdown(lines, env, slugify) {
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  let words = 0;
  for (let k = 0; k < lines.length; k++) words += countWords(lines[k]);
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      parts.push('<pre><code' + (lang === '' ? '' : ' class="language-' + esc(lang) + '"') + '>');
      for (let k = 0; k < body.length; k++) parts.push(esc(body[k]), '\n');
      parts.push('</code></pre>', '\n');
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text), ids);
      const html = inline(hd.text, env);
      parts.push('<h' + hd.depth + ' id="' + id + '">', html, '</h' + hd.depth + '>', '\n');
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) { parts.push('<hr>', '\n'); i++; continue; }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (let k = 0; k < body.length; k++) {
        const t = trimST(body[k]);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) parts.push('<blockquote>\n</blockquote>', '\n');
      else {
        parts.push('<blockquote>\n<p>');
        inlineInto(kept.join('\n'), env, parts);
        parts.push('</p>\n</blockquote>', '\n');
      }
      continue;
    }
    const b = bulletOf(line);
    const o = b === null ? orderedOf(line) : null;
    if (b !== null || o !== null) {
      const isOrdered = o !== null;
      const items = [];
      const start = isOrdered ? o.start : 1;
      while (i < n) {
        const l = lines[i];
        if (isOrdered) {
          const m = orderedOf(l);
          if (m !== null) { items.push([trimST(m.text)]); i++; continue; }
        } else {
          const m = bulletOf(l);
          if (m !== null) { items.push([trimST(m)]); i++; continue; }
        }
        if (isContinued(l)) { items[items.length - 1].push(trimST(l)); i++; continue; }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      parts.push(isOrdered && start !== 1 ? '<ol start="' + start + '">' : '<' + tag + '>', '\n');
      for (let k = 0; k < items.length; k++) {
        parts.push('<li>');
        inlineInto(items[k].join('\n'), env, parts);
        parts.push('</li>', '\n');
      }
      parts.push('</' + tag + '>', '\n');
      continue;
    }
    const body = [trimST(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimST(lines[i++]));
    const text = body.join('\n');
    const html = inline(text, env);
    if (excerpt === null) excerpt = html;
    parts.push('<p>', html, '</p>', '\n');
  }
  return { html: parts.join(''), toc, excerpt: excerpt === null ? '' : excerpt, words };
}

// ----- templates -----

class TemplateError extends Error {}
const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;
const T_BLANK = /^[ \t]*$/;

function tPathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: tPathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = T_BLANK.test(src.slice(lineStart, open)) && T_BLANK.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: tPathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: tPathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError('template "' + name + '": an else outside an if');
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else !== null ? parent.else : parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return root.body;
}

// ----- template value helpers (module-level, passed into compiled code) -----

function lk(sc, name) {
  for (let i = sc.length - 1; i >= 0; i--) {
    const f = sc[i];
    if (f !== null && typeof f === 'object' && Object.hasOwn(f, name)) return f[name];
  }
  return undefined;
}
function gp(v, key) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, key) ? v[key] : undefined;
}
function tx(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i !== 0) s += ', ';
      s += tx(v[i]);
    }
    return s;
  }
  return '';
}
function ty(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Names a template reads from its incoming scope (not bound by its own fors),
// computed to a fixpoint over includes.
function computeFree(nodesByName) {
  const free = new Map();
  for (const name of nodesByName.keys()) free.set(name, new Set());
  const walk = (nodes, bound, out) => {
    for (const n of nodes) {
      if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if') {
        if (!bound.has(n.path[0])) out.add(n.path[0]);
      } else if (n.kind === 'for') {
        if (!bound.has(n.path[0])) out.add(n.path[0]);
        const b2 = new Set(bound);
        b2.add(n.name);
        b2.add('loop');
        walk(n.body, b2, out);
      } else if (n.kind === 'include') {
        const f = free.get(n.name);
        if (f) for (const x of f) if (!bound.has(x)) out.add(x);
      }
    }
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, nodes] of nodesByName) {
      const s = free.get(name);
      const before = s.size;
      walk(nodes, new Set(), s);
      if (s.size !== before) changed = true;
    }
  }
  return free;
}

// Longest include chain starting at a template (8+ where a cycle makes it unbounded).
function makeChainOf(nodesByName) {
  const chain = new Map();
  const visiting = new Set();
  const includesOf = (nodes, acc) => {
    for (const n of nodes) {
      if (n.kind === 'include') acc.push(n.name);
      else if (n.kind === 'for') includesOf(n.body, acc);
      else if (n.kind === 'if') {
        includesOf(n.then, acc);
        if (n.else !== null) includesOf(n.else, acc);
      }
    }
  };
  const chainOf = (name) => {
    if (chain.has(name)) return chain.get(name);
    if (visiting.has(name)) return 8;
    const nodes = nodesByName.get(name);
    if (!nodes) return 0;
    visiting.add(name);
    const inc = [];
    includesOf(nodes, inc);
    let m = 0;
    for (const x of inc) {
      const c = 1 + chainOf(x);
      if (c > m) m = c;
    }
    visiting.delete(name);
    chain.set(name, m);
    return m;
  };
  return chainOf;
}

const T_GLOBALS = new Set(['site', 'tags', 'recent']);

// Code generation: templates become JS functions
//   fn(sc, R, esc, tx, lk, gp, ty, d) -> string
// sc is the scope stack (root vars at [0], loop frames pushed on top);
// __b is sc.length on entry, so a lexically bound loop variable at for-stack
// position j lives at sc[__b + j]; R renders an include (with memoisation).
function pathExpr(path, forStack, loopNames) {
  const first = path[0];
  let e;
  if (first === 'loop') {
    e = forStack.length > 0 ? 'sc[__b+' + (forStack.length - 1) + '].loop' : 'lk(sc,"loop")';
  } else {
    let idx = -1;
    for (let j = forStack.length - 1; j >= 0; j--) {
      if (forStack[j] === first) { idx = j; break; }
    }
    if (idx !== -1) e = 'sc[__b+' + idx + '].' + first;
    else if (!loopNames.has(first)) e = 'sc[0].' + first;
    else e = 'lk(sc,' + JSON.stringify(first) + ')';
  }
  for (let k = 1; k < path.length; k++) e = 'gp(' + e + ',' + JSON.stringify(path[k]) + ')';
  return e;
}

function genNodes(nodes, st, out) {
  for (const n of nodes) {
    if (n.kind === 'text') {
      out.push('o+=' + JSON.stringify(n.text) + ';');
    } else if (n.kind === 'var') {
      out.push('o+=esc(tx(' + pathExpr(n.path, st.forStack, st.loopNames) + '));');
    } else if (n.kind === 'raw') {
      out.push('o+=tx(' + pathExpr(n.path, st.forStack, st.loopNames) + ');');
    } else if (n.kind === 'if') {
      out.push('if(ty(' + pathExpr(n.path, st.forStack, st.loopNames) + ')!==' + (n.not ? 'true' : 'false') + '){');
      genNodes(n.then, st, out);
      if (n.else !== null) {
        out.push('}else{');
        genNodes(n.else, st, out);
      }
      out.push('}');
    } else if (n.kind === 'for') {
      const u = st.uid++;
      out.push('{const __x' + u + '=' + pathExpr(n.path, st.forStack, st.loopNames) + ';if(Array.isArray(__x' + u + ')){');
      out.push('const __f' + u + '={' + n.name + ':null,loop:{index:0,first:false,last:false,length:__x' + u + '.length}};sc.push(__f' + u + ');');
      out.push('for(let __k' + u + '=0;__k' + u + '<__x' + u + '.length;__k' + u + '++){__f' + u + '.' + n.name + '=__x' + u + '[__k' + u + '];__f' + u + '.loop.index=__k' + u + '+1;__f' + u + '.loop.first=__k' + u + '===0;__f' + u + '.loop.last=__k' + u + '===__x' + u + '.length-1;');
      st.forStack.push(n.name);
      genNodes(n.body, st, out);
      st.forStack.pop();
      out.push('}sc.pop();}}');
    } else if (n.kind === 'include') {
      const siteId = st.plans.length;
      let plan = null;
      const f = st.free.get(n.name);
      if (f !== undefined && !f.has('loop')) {
        const keys = [];
        let ok = true;
        for (const x of f) {
          if (T_GLOBALS.has(x)) continue;
          if (st.forStack.indexOf(x) === -1) { ok = false; break; }
          keys.push(x);
        }
        if (ok && keys.length <= 2) plan = { kind: keys.length === 0 ? 'global' : 'keyed', keys, chain: st.chainOf(n.name) };
      }
      st.plans.push(plan);
      let call = 'o+=R(' + siteId + ',' + JSON.stringify(n.name) + ',sc,d+1';
      for (const k of plan === null ? [] : plan.keys) call += ',' + pathExpr([k], st.forStack, st.loopNames);
      call += ');';
      out.push(call);
    }
  }
}

// ----- the build -----

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  const slugCache = new Map();
  const slugify = (t) => {
    let s = slugCache.get(t);
    if (s === undefined) {
      s = NON_ASCII.test(t) ? slugifySlow(t) : slugifyFast(t);
      slugCache.set(t, s);
    }
    return s;
  };
  const base = input.site.base_url.replace(/\/+$/, '');
  const report = [];
  const broken = new Set();

  // 1. Templates, parsed in code-unit order of name; one that does not parse
  //    is reported and left out.
  const nodesByName = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      nodesByName.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // 2. Compile the templates; work out what each one reads, every for-name
  //    in the case, and the include plans (what may be memoised).
  const free = computeFree(nodesByName);
  const chainOf = makeChainOf(nodesByName);
  const loopNames = new Set();
  const collectFors = (nodes) => {
    for (const n of nodes) {
      if (n.kind === 'for') {
        loopNames.add(n.name);
        collectFors(n.body);
      } else if (n.kind === 'if') {
        collectFors(n.then);
        if (n.else !== null) collectFors(n.else);
      }
    }
  };
  for (const nodes of nodesByName.values()) collectFors(nodes);
  const plans = [];
  const fns = new Map();
  const gcache = new Map();
  const kcache = new Map();
  const R = (siteId, name, sc, depth, k1, k2) => {
    const fn = fns.get(name);
    if (fn === undefined || depth >= 8) return '';
    const plan = plans[siteId];
    if (plan === undefined || plan === null || depth + plan.chain >= 8) return fn(sc, R, esc, tx, lk, gp, ty, depth);
    if (plan.kind === 'global') {
      let s = gcache.get(name);
      if (s === undefined) {
        s = fn(sc, R, esc, tx, lk, gp, ty, depth);
        gcache.set(name, s);
      }
      return s;
    }
    let m = kcache.get(name);
    if (m === undefined) {
      m = new Map();
      kcache.set(name, m);
    }
    if (plan.keys.length === 2) {
      let m2 = m.get(k1);
      if (m2 === undefined) {
        m2 = new Map();
        m.set(k1, m2);
      }
      let s = m2.get(k2);
      if (s === undefined) {
        s = fn(sc, R, esc, tx, lk, gp, ty, depth);
        m2.set(k2, s);
      }
      return s;
    }
    let s = m.get(k1);
    if (s === undefined) {
      s = fn(sc, R, esc, tx, lk, gp, ty, depth);
      m.set(k1, s);
    }
    return s;
  };
  for (const [name, nodes] of nodesByName) {
    const st = { forStack: [], uid: 0, loopNames, plans, free, chainOf };
    const out = [];
    genNodes(nodes, st, out);
    fns.set(name, new Function('sc', 'R', 'esc', 'tx', 'lk', 'gp', 'ty', 'd', 'const __b=sc.length;let o="";' + out.join('') + 'return o;'));
  }

  // 3. Sources, in code-unit order of path; line ends made "\n".
  const files = [...input.files].sort((a, b) => byCodeUnits(a.path, b.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const content = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, lines: content.split('\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 4. Front matter, in order: refused, generator-owned dir, post without a
  //    date, unknown layout, draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      report.push('refused ' + s.path + ': ' + fm.error);
      continue;
    }
    s.data = fm.data;
    s.bodyLines = s.lines.slice(fm.close + 1);
    s.lines = null;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own');
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push('refused ' + s.path + ': a post needs a date');
      continue;
    }
    const layout = s.data.layout !== undefined ? s.data.layout : (s.post ? 'post' : 'page');
    if (!nodesByName.has(layout)) {
      report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push('draft ' + s.path);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 5. Permalinks: slugs made unique per directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug !== undefined ? s.data.slug : slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // 6. Markdown, each body's links resolved.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
        if (path !== null && staticPaths.has(path)) return base + '/' + path + frag;
        broken.add('broken-link ' + s.path + ' -> ' + target);
        return target;
      },
    };
    const md = renderMarkdown(s.bodyLines, env, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.reading = Math.max(1, Math.ceil(md.words / 200));
    s.bodyLines = null;
  }

  // 7. Collections: posts newest first, equal dates by slug; neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 8. Tags, grouped by slug, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags === undefined ? [] : s.data.tags;
    for (let k = 0; k < tags.length; k++) {
      const name = tags[k];
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      const t = bySlug.get(slug);
      return t !== undefined ? t : { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 9. Layouts. One view object per source serves as its page and as its
  //    card, so no field is ever built twice.
  const linkOf = (s) => (s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date === undefined ? '' : s.data.date,
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  });
  const viewOf = (s) => {
    if (s.view !== undefined) return s.view;
    const v = {
      title: s.data.title,
      url: s.url,
      date: s.data.date === undefined ? '' : s.data.date,
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary === undefined ? '' : s.data.summary,
      excerpt: s.excerpt,
      reading_minutes: s.reading,
      tags: s.tagRefs,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: s.post ? linkOf(s.newer) : null,
      older: s.post ? linkOf(s.older) : null,
      is_post: s.post,
    };
    s.view = v;
    return v;
  };
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => viewOf(p));
  const render = (name, vars) => {
    const fn = fns.get(name);
    if (fn === undefined) return null;
    return fn([{ site, tags: allTags, recent, ...vars }], R, esc, tx, lk, gp, ty, 0);
  };
  const output = {};
  for (const s of sources) output[s.outDir + '/index.html'] = render(s.layout, { page: viewOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => viewOf(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => viewOf(p)) } });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  // 10. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (const s of sources) if (!s.post) pageCount++;
  lines.push('built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  output[REPORT_FILE] = lines.join('\n') + '\n';
  return output;
}
