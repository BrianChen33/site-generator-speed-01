// A faster drop-in for makefun-site 1.0.0, written from scratch in this session.
// It returns exactly the answer makefun-site 1.0.0's build returns for every input:
// the same output tree, byte for byte. The code is my own implementation of the
// dialect stated in makefun-site's README.md (front matter, template dialect,
// Markdown subset, slug rule, report), with its vendor code as the reference
// wherever the two differ. No dependency, no install, no WASM, no native code.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';
const INCLUDE_DEPTH = 8;
const SLUG_MAX = 64;

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  if (!ESC_RE.test(text)) return text;
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * Escape the slice text[a..b) of a string that is known to hold a special
 * character only when `dirty` is true; returns the slice unchanged otherwise.
 * The caller tracks `dirty` while scanning, so no second scan is needed.
 */
function escapeSlice(text, a, b, dirty) {
  if (a === b) return '';
  const s = text.slice(a, b);
  return dirty ? s.replace(/[&<>"']/g, (c) => ESCAPES[c]) : s;
}

/** Whether a character code is one of the five HTML-escaped characters. */
function isEscapedChar(code) {
  return code === 38 || code === 60 || code === 62 || code === 34 || code === 39; // & < > " '
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date, cache) {
  let v = cache.get(date);
  if (v === undefined) {
    const y = date.slice(0, 4);
    const m = Number(date.slice(5, 7));
    const d = Number(date.slice(8, 10));
    v = `${d} ${MONTHS[m - 1]} ${y}`;
    cache.set(date, v);
  }
  return v;
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 * Pure-ASCII input skips the normalisation (NFKD and mark-stripping are
 * no-ops on ASCII). Results are cached per build.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  if (/[^\x00-\x7F]/.test(text)) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const res = out === '' ? 'untitled' : out;
  cache.set(text, res);
  return res;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out. */
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

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isDigit(code) {
  return code >= 48 && code <= 57;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    // '"'
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
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = false;
      let y = 0;
      let mo = 0;
      let d = 0;
      if (
        raw.length === 10 &&
        isDigit(raw.charCodeAt(0)) && isDigit(raw.charCodeAt(1)) && isDigit(raw.charCodeAt(2)) && isDigit(raw.charCodeAt(3)) &&
        raw.charCodeAt(4) === 45 && isDigit(raw.charCodeAt(5)) && isDigit(raw.charCodeAt(6)) &&
        raw.charCodeAt(7) === 45 && isDigit(raw.charCodeAt(8)) && isDigit(raw.charCodeAt(9))
      ) {
        y = Number(raw.slice(0, 4));
        mo = Number(raw.slice(5, 7));
        d = Number(raw.slice(8, 10));
        ok = y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' }; // [ ]
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let k = 0; k < tags.length; k++) {
        const t = tags[k].trim();
        tags[k] = t;
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let j = 0; j < t.length; j++) {
          const c = t.charCodeAt(j);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      // /^[a-z0-9]+(?:-[a-z0-9]+)*$/
      let i = 0;
      while (true) {
        if (i >= raw.length) return { error: 'key "slug": not a slug' };
        let c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) return { error: 'key "slug": not a slug' };
        while (i < raw.length && ((c = raw.charCodeAt(i)) >= 97 && c <= 122) || (c >= 48 && c <= 57)) i++;
        if (i === raw.length) break;
        if (raw.charCodeAt(i) !== 45) return { error: 'key "slug": not a slug' };
        i++;
      }
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Trim trailing spaces and tabs, as the front-matter line rule does. */
function trimLineEnd(s) {
  let e = s.length;
  while (e > 0) {
    const c = s.charCodeAt(e - 1);
    if (c !== 32 && c !== 9) break;
    e--;
  }
  return e === s.length ? s : s.slice(0, e);
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused.
 */
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (line === '') continue;
    let blank = true;
    for (let j = 0; j < line.length; j++) {
      const c = line.charCodeAt(j);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (blank || line.charCodeAt(0) === 35) continue; // blank, or a comment opening on '#'
    // "key: value": a key of a-z and _, a colon, one space and the value.
    const colon = line.indexOf(':');
    if (colon <= 0) return { error: `line ${i + 1} is not "key: value"` };
    let keyOk = true;
    for (let j = 0; j < colon; j++) {
      const c = line.charCodeAt(j);
      if (!((c >= 97 && c <= 122) || c === 95)) {
        keyOk = false;
        break;
      }
    }
    if (!keyOk) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, colon);
    let raw;
    if (colon === line.length - 1) raw = '';
    else if (line.charCodeAt(colon + 1) === 32) raw = line.slice(colon + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    raw = trimLineEnd(raw);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes, as a table over char codes. */
const ESCAPABLE_CODES = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE_CODES[ch.charCodeAt(0)] = 1;
const isEscapableCode = (code) => code < 128 && ESCAPABLE_CODES[code] === 1;

/** The first index from `from` where `s` holds `what` outside an escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether `s` holds whitespace (the link target's test). */
const HAS_WS = /\s/;
const TRIM_BOTH = /^[ \t]+|[ \t]+$/g;

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  const n = s.length;
  let out = '';
  let i = 0;
  let runStart = 0;
  let dirty = false;
  while (i < n) {
    const code = s.charCodeAt(i);
    if (code === 92 && i + 1 < n && isEscapableCode(s.charCodeAt(i + 1))) {
      // A backslash before an escapable character writes that character (escaped).
      out += escapeSlice(s, runStart, i, dirty);
      const e = s[i + 1];
      out += e === '>' ? '&gt;' : e;
      i += 2;
      runStart = i;
      dirty = false;
      continue;
    }
    if (code === 96) {
      // A backtick opens a code span closed by the next backtick, with at least one character between.
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += escapeSlice(s, runStart, i, dirty);
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
        runStart = i;
        dirty = false;
      } else {
        i++;
      }
      continue;
    }
    if (code === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        // `**` opens strong, closed by the next `**` not escaped, with at least one character between.
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out += escapeSlice(s, runStart, i, dirty);
          out += `<strong>${inline(s.slice(i + 2, j), env)}</strong>`;
          i = j + 2;
          runStart = i;
          dirty = false;
        } else {
          i += 2;
        }
        continue;
      }
      // A single `*` opens emphasis, closed by the next single `*` not beside another `*`.
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        out += escapeSlice(s, runStart, i, dirty);
        out += `<em>${inline(s.slice(i + 1, j), env)}</em>`;
        i = j + 1;
        runStart = i;
        dirty = false;
      } else {
        i++;
      }
      continue;
    }
    if (code === 91) {
      // `[text](target)`: the first `]` not escaped closes the text, `(` must follow at once.
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !HAS_WS.test(target)) {
        out += escapeSlice(s, runStart, i, dirty);
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
        i = m + 1;
        runStart = i;
        dirty = false;
        continue;
      }
      i++;
      continue;
    }
    if (isEscapedChar(code)) dirty = true;
    i++;
  }
  out += escapeSlice(s, runStart, n, dirty);
  return out;
}

// Block kinds, from one manual classification of a line.
const B_BLANK = 0;
const B_FENCE = 1; // value: the language
const B_HEADING = 2; // value: depth, text
const B_HR = 3;
const B_QUOTE = 4;
const B_BULLET = 5; // value: item text
const B_ORDERED = 6; // value: start, item text
const B_OTHER = 7;

function isSpaceTab(code) {
  return code === 32 || code === 9;
}

/** Trim spaces and tabs at both ends of a line. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && isSpaceTab(line.charCodeAt(a))) a++;
  while (b > a && isSpaceTab(line.charCodeAt(b - 1))) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/**
 * Classify one line, returning [kind, ...values]. A single pass replaces the
 * baseline's per-line regexes, with identical answers:
 * blank /^[ \t]*$/, fence /^```([A-Za-z0-9_+-]*)[ \t]*$/, heading
 * /^(#{1,6})[ \t]+(.*?)[ \t]*$/ (text never empty), hr /^(?:---|\*\*\*)[ \t]*$/,
 * quote /^>/, bullet /^[-*] (.*)$/, ordered /^(\d{1,9})\. (.*)$/.
 */
function classify(line) {
  const len = line.length;
  if (len === 0) return [B_BLANK];
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) {
    // Could be blank (all spaces/tabs), or a continued list line; only the
    // blank check matters here, the rest is paragraph text.
    let allBlank = true;
    for (let j = 1; j < len; j++) {
      if (!isSpaceTab(line.charCodeAt(j))) {
        allBlank = false;
        break;
      }
    }
    return allBlank ? [B_BLANK] : [B_OTHER];
  }
  if (c0 === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96) {
    // Fence open: three backticks, a language of [A-Za-z0-9_+-]*, then spaces/tabs only.
    let j = 3;
    while (j < len) {
      const c = line.charCodeAt(j);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
      else break;
    }
    const lang = line.slice(3, j);
    while (j < len && isSpaceTab(line.charCodeAt(j))) j++;
    if (j === len) return [B_FENCE, lang];
    return [B_OTHER];
  }
  if (c0 === 35) {
    // Heading: 1-6 '#', at least one space/tab, then text (trailing spaces/tabs dropped).
    let j = 1;
    while (j < len && line.charCodeAt(j) === 35) j++;
    if (j <= 6 && j < len && isSpaceTab(line.charCodeAt(j))) {
      let k = j;
      while (k < len && isSpaceTab(line.charCodeAt(k))) k++;
      let e = len;
      while (e > k && isSpaceTab(line.charCodeAt(e - 1))) e--;
      if (e > k) return [B_HEADING, j, line.slice(k, e)];
    }
    return [B_OTHER];
  }
  if ((c0 === 45 || c0 === 42) && len >= 3) {
    // '---' or '***' then spaces/tabs only (hr), or '- '/'* ' (bullet).
    if (line.charCodeAt(1) === c0 && line.charCodeAt(2) === c0) {
      let j = 3;
      while (j < len && isSpaceTab(line.charCodeAt(j))) j++;
      if (j === len) return [B_HR];
    }
    if (line.charCodeAt(1) === 32) return [B_BULLET, line.slice(2)];
    return [B_OTHER];
  }
  if (c0 === 62) return [B_QUOTE]; // '>'
  if (c0 >= 48 && c0 <= 57) {
    // Ordered: 1-9 digits, '. ', then the item text.
    let j = 1;
    while (j < len && j < 9 && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
    if (j < len && line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) {
      return [B_ORDERED, Number(line.slice(0, j)), line.slice(j + 2)];
    }
    return [B_OTHER];
  }
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return [B_BULLET, line.slice(2)];
  return [B_OTHER];
}

/** Whether `line` is a fence close: /^```[ \t]*$/. */
function isFenceClose(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) if (!isSpaceTab(line.charCodeAt(j))) return false;
  return true;
}

/** Whether `line` continues a list item: /^ {2,}\S/. */
function isContinued(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let j = 2;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  if (j >= line.length) return false;
  const c = line.charCodeAt(j);
  return c !== 32 && c !== 9 && c !== 10 && c !== 11 && c !== 12 && c !== 13;
}

/** Whether `line` ends a paragraph: blank, fence, heading or thematic break. */
function endsParagraph(line) {
  const k = classify(line)[0];
  return k === B_BLANK || k === B_FENCE || k === B_HEADING || k === B_HR;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading) and its excerpt
 * (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env, cx) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const total = lines.length;
  while (i < total) {
    const line = lines[i];
    const cl = classify(line);
    const kind = cl[0];
    if (kind === B_BLANK) {
      i++;
      continue;
    }
    if (kind === B_FENCE) {
      const lang = cl[1];
      i++;
      let code = '';
      while (i < total && !isFenceClose(lines[i])) {
        code += `${escapeHtml(lines[i])}\n`;
        i++;
      }
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      blocks.push(`<pre><code${cls}>${code}</code></pre>`);
      continue;
    }
    if (kind === B_HEADING) {
      const depth = cl[1];
      const text = cl[2];
      const id = uniqueSlug(slugify(text, cx.slugCache), ids);
      const html = inline(text, env);
      blocks.push(`<h${depth} id="${id}">${html}</h${depth}>`);
      if (depth === 2 || depth === 3) toc.push({ level: depth, id, html });
      i++;
      continue;
    }
    if (kind === B_HR) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (kind === B_QUOTE) {
      const body = [];
      while (i < total && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        body.push(l.length >= 2 && l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        i++;
      }
      const kept = [];
      for (let k = 0; k < body.length; k++) {
        const t = trimLine(body[k]);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    if (kind === B_BULLET || kind === B_ORDERED) {
      const isOrdered = kind === B_ORDERED;
      const start = isOrdered ? cl[1] : 1;
      const items = [];
      while (i < total) {
        const l = lines[i];
        const m = classify(l);
        if (m[0] === kind) {
          // A following line of the same kind is another item; for ordered
          // lists the marker's number may differ, the kind is what matters.
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let out = `${open}\n`;
      for (let k = 0; k < items.length; k++) out += `<li>${inline(items[k].join('\n'), env)}</li>\n`;
      out += `</${tag}>`;
      blocks.push(out);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < total && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
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
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let k = 0; k < v.length; k++) {
      if (k > 0) out += ', ';
      out += textOf(v[k]);
    }
    return out;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out` in `scope` ({ vars, parent }). `ctx` holds the
 * parsed templates, the HTML escape and the include depth.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        // One scope object per execution of this for, its loop record and
        // element binding mutated per iteration: nothing retains a scope
        // past its iteration, so reuse is exact.
        const loop = { index: 1, first: true, last: false, length: xs.length };
        const vars = { loop };
        const child = { vars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, child, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/**
 * The words of a body: its runs of characters other than whitespace, counted
 * without allocating (the baseline's /\S+/g match builds one string per word).
 * ASCII whitespace is space, tab, \n, \v, \f and \r; anything else is tested
 * with the same \s the match uses, so the count is identical.
 */
const WS_SINGLE = /\s/;
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13) ws = true;
    else if (c < 128) ws = false;
    else ws = WS_SINGLE.test(text[i]);
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const cx = { slugCache: new Map(), dateCache: new Map() };
  const templates = new Map();
  const report = [];
  const tNames = Object.keys(input.templates).sort(byCodeUnits);
  for (let ti = 0; ti < tNames.length; ti++) {
    const name = tNames[ti];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    if (f.path.endsWith('.md')) {
      const content = f.content;
      sources.push({ path: f.path, text: content.indexOf('\r') === -1 ? content : content.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (let si = 0; si < sources.length; si++) {
    const s = sources[si];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, cx.slugCache), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const broken = new Set();
  const staticPaths = new Set();
  for (let fi = 0; fi < statics.length; fi++) staticPaths.add(statics[fi].path);
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, cx);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = [];
  for (let si = 0; si < kept.length; si++) if (kept[si].post) posts.push(kept[si]);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. The tags: grouped by their slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (let k = 0; k < tags.length; k++) {
      const name = tags[k];
      const slug = slugify(name, cx.slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (let k = 0; k < posts.length; k++) {
    const p = posts[k];
    p.tagRefs = [];
    const names = ownTags(p);
    for (let j = 0; j < names.length; j++) {
      const name = names[j];
      const slug = slugify(name, cx.slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    if (s.post) continue;
    const names = ownTags(s);
    s.tagRefs = [];
    for (let j = 0; j < names.length; j++) {
      const name = names[j];
      const slug = slugify(name, cx.slugCache);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // A post's card, as lists show it (one per source: lists and the page's own layout read the same values).
  const cards = new Map();
  const cardOf = (s) => {
    let card = cards.get(s);
    if (card !== undefined) return card;
    card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date, cx.dateCache),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    cards.set(s, card);
    return card;
  };
  for (let k = 0; k < posts.length; k++) cardOf(posts[k]);

  const linkOf = (s) =>
    s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date, cx.dateCache) };

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  const ctx = { templates, escape: escapeHtml };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    const card = cardOf(s);
    const page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let ti = 0; ti < tags.length; ti++) {
    const t = tags[ti];
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let fi = 0; fi < statics.length; fi++) {
    const f = statics[fi];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (let si = 0; si < kept.length; si++) if (!kept[si].post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
