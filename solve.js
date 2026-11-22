// SPDX-License-Identifier: MIT
//
// solve.js: makefun-site 1.0.0's build(input) re-implemented for this entry, dependency-free.
//
// The rules, in my own words, as the reference states and runs them:
//
//   input   { site: { title, base_url, per_page, recent }, templates: { name: source }, files: [{ path, content }] };
//           output is a plain object, output path -> file text. No clock, environment, randomness or file is read.
//   order   files sorted by path in code-unit order (a .md file is a source, "\r\n" and "\r" made "\n"; anything else
//           is static); every template parsed in code-unit order of its name, one that does not parse reported and
//           dropped; then, per source in that order: front matter, then the reserved-directory, post-date, layout and
//           draft checks (first failure reported); then each page's slug made unique per output directory; then its
//           body's Markdown with its links resolved; then the posts; then the tags; then every layout; then the
//           statics; then the report.
//   slugs   a post's directory is "posts", a page's its source's directory; the slug is the "slug" key or the slug of
//           the title, made unique in that directory by "-2", "-3", ...; at the root "posts", "tags" and "page" are
//           taken from the start. A page is written to <dir>/<slug>/index.html and its url is <base>/<dir>/<slug>/.
//   tags    each post's tags deduped by slug, first spelling kept; a tag's url is <base>/tags/<slug>/; ordered by post
//           count, most first, then by slug; a page's tags link to the tag of the same slug or have url "".
//   layouts every source through its layout with "page"; the index through "index" per_page posts a page, with
//           "posts" and "pager"; each tag through "tag"; then "tags/index.html" through "tags"; every template also
//           sees "site", "tags" and "recent". A static file whose path a built page took is reported, not written.
//   report  every template error, refusal, draft, shadowed path and broken link, sorted by code units, then
//           "built <pages> pages, <posts> posts, <tags> tags and <statics> static files", each line ending in "\n".
//
// The speed comes from the shape of the work: one scan per string with a character table instead of a regex, escaping
// and inline Markdown copying whole runs instead of characters, Markdown rendered straight from its lines with no
// block-token objects, templates parsed once and rendered over a scope stack (no per-iteration scope objects), and
// the output built by one string append per node.

// ---------------------------------------------------------------- character tables

/**
 * One table for the two hot scans, by code unit: bit 0 the characters that end a run of inline Markdown text, bit 1
 * the five the HTML escape table names. Built once, read everywhere.
 */
const SPECIAL = new Uint8Array(65536);
for (const ch of '\\`*[') SPECIAL[ch.charCodeAt(0)] |= 1;
for (const ch of '&<>"\'') SPECIAL[ch.charCodeAt(0)] |= 3;

/** JavaScript's \s by code unit, for the words of a body (its complement is \S): a scan is one load per character. */
const WHITESPACE = new Uint8Array(65536);

const AMP = '&amp;';
const LT = '&lt;';
const GT = '&gt;';
const QUOT = '&quot;';
const APOS = '&#39;';

/** `s` with & < > " and ' escaped: the escape table is those five and nothing else, so runs are copied whole. */
function escapeHtml(s) {
  const n = s.length;
  let i = 0;
  while (i < n) {
    if ((SPECIAL[s.charCodeAt(i)] & 2) !== 0) break;
    i++;
  }
  if (i === n) return s;
  let out = s.slice(0, i);
  let start = i;
  for (; i < n; i++) {
    const c = s.charCodeAt(i);
    if ((SPECIAL[c] & 2) !== 0) {
      if (i > start) out += s.slice(start, i);
      out += c === 38 ? AMP : c === 60 ? LT : c === 62 ? GT : c === 34 ? QUOT : APOS;
      start = i + 1;
    }
  }
  if (start < n) out += s.slice(start);
  return out;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;
const NON_ASCII = /[^\x00-\x7f]/;
const MARKS = /\p{M}/gu;

/** a-z, A-Z and 0-9 by code unit, the characters a slug keeps (a run of anything else becomes one "-"). */
const ALNUM = new Uint8Array(128);
for (let c = 48; c <= 57; c++) ALNUM[c] = 1;
for (let c = 65; c <= 90; c++) ALNUM[c] = 1;
for (let c = 97; c <= 122; c++) ALNUM[c] = 1;

/** The slug of `text`: NFKD and no marks, A-Z lowered, each run outside a-z0-9 one "-", 64 characters at most. */
function slugify(text) {
  let plain = text;
  if (NON_ASCII.test(text)) plain = text.normalize('NFKD').replace(MARKS, '');
  const n = plain.length;
  let out = '';
  let start = 0;
  let k = 0;
  while (k < n) {
    if (ALNUM[plain.charCodeAt(k)] === 1) {
      k++;
      continue;
    }
    if (k > start) out += plain.slice(start, k);
    out += '-';
    k++;
    while (k < n && ALNUM[plain.charCodeAt(k)] !== 1) k++;
    start = k;
  }
  if (start < n) out += plain.slice(start);
  let s = out;
  if (s.charCodeAt(0) === 45) s = s.slice(1);
  if (s.length > SLUG_MAX) s = s.slice(0, SLUG_MAX);
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 45) end--;
  if (end !== s.length) s = s.slice(0, end);
  if (s === '') return 'untitled';
  return s.toLowerCase();
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  if (taken.has(out)) {
    let n = 2;
    do {
      out = `${slug}-${n}`;
      n++;
    } while (taken.has(out));
  }
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const first = date.indexOf('-');
  const second = date.indexOf('-', first + 1);
  const month = Number(date.slice(first + 1, second));
  const day = Number(date.slice(second + 1));
  return `${day} ${MONTHS[month - 1]} ${date.slice(0, first)}`;
}

/** Whether code unit `c` is JavaScript's \s (so \S is its complement): the table is the definition, filled below. */
function isSpaceCode(c) {
  return WHITESPACE[c] === 1;
}

for (let c = 9; c <= 13; c++) WHITESPACE[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WHITESPACE[c] = 1;
for (const c of [32, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WHITESPACE[c] = 1;

/** The words of a text: its runs of characters other than whitespace, four characters a turn. */
function wordsOf(text) {
  const n = text.length;
  let count = 0;
  let inWord = 0;
  let i = 0;
  const ring = n - 3;
  for (; i < ring; i += 4) {
    const c0 = text.charCodeAt(i);
    const c1 = text.charCodeAt(i + 1);
    const c2 = text.charCodeAt(i + 2);
    const c3 = text.charCodeAt(i + 3);
    if (WHITESPACE[c0] === 1) inWord = 0;
    else if (inWord === 0) {
      inWord = 1;
      count++;
    }
    if (WHITESPACE[c1] === 1) inWord = 0;
    else if (inWord === 0) {
      inWord = 1;
      count++;
    }
    if (WHITESPACE[c2] === 1) inWord = 0;
    else if (inWord === 0) {
      inWord = 1;
      count++;
    }
    if (WHITESPACE[c3] === 1) inWord = 0;
    else if (inWord === 0) {
      inWord = 1;
      count++;
    }
  }
  for (; i < n; i++) {
    if (WHITESPACE[text.charCodeAt(i)] === 1) inWord = 0;
    else if (inWord === 0) {
      inWord = 1;
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------- Markdown

const ESCAPABLE = new Uint8Array(65536);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;

/** Whether `line` is blank: spaces and tabs only. */
function isBlank(line) {
  const n = line.length;
  for (let i = 0; i < n; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** The kinds of block a line can start, as the integers the Markdown loop dispatches on. */
const LINE_TEXT = 0;
const LINE_BLANK = 1;
const LINE_FENCE = 2;
const LINE_HEADING = 3;
const LINE_HR = 4;
const LINE_QUOTE = 5;
const LINE_BULLET = 6;
const LINE_ORDERED = 7;

/**
 * What `line` starts: one first character decides which of the seven rules can even apply — and in the order the rules
 * are stated in (blank, fence, heading, break, quote, bullet, ordered) — so a block costs one read, not seven checks.
 */
function lineKind(line) {
  const c = line.charCodeAt(0);
  if (c === 96) return fenceOpenLang(line) !== -1 ? LINE_FENCE : LINE_TEXT;
  if (c === 35) return headingOf(line) !== 0 ? LINE_HEADING : LINE_TEXT;
  if (c === 45 || c === 42) {
    if (isHr(line)) return LINE_HR;
    return line.length >= 2 && line.charCodeAt(1) === 32 ? LINE_BULLET : LINE_TEXT;
  }
  if (c === 62) return LINE_QUOTE;
  if (c === 32 || c === 9) return isBlank(line) ? LINE_BLANK : LINE_TEXT;
  if (c >= 48 && c <= 57) return orderedContentStart(line) !== -1 ? LINE_ORDERED : LINE_TEXT;
  return c !== c ? LINE_BLANK : LINE_TEXT;
}

/** `line` without spaces and tabs at either end. */
function trimLine(line) {
  const n = line.length;
  let i = 0;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    i++;
  }
  if (i === n) return '';
  let end = n;
  while (end > i) {
    const c = line.charCodeAt(end - 1);
    if (c !== 32 && c !== 9) break;
    end--;
  }
  return i === 0 && end === n ? line : line.slice(i, end);
}

/** Where a fence's language ends (3 when it has none), or -1 when `line` opens no fence. */
function fenceOpenLang(line) {
  const n = line.length;
  if (n < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return -1;
  let k = 3;
  while (k < n) {
    const c = line.charCodeAt(k);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) k++;
    else break;
  }
  const langEnd = k;
  while (k < n) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return -1;
    k++;
  }
  return langEnd;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  const n = line.length;
  if (n < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < n; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's depth (1 to 6) or 0: 1 to 6 "#", a space or tab, then text. */
function headingOf(line) {
  const n = line.length;
  if (line.charCodeAt(0) !== 35) return 0;
  let k = 0;
  while (k < n && line.charCodeAt(k) === 35) k++;
  const depth = k;
  if (depth > 6 || depth === n) return 0;
  const c = line.charCodeAt(k);
  if (c !== 32 && c !== 9) return 0;
  while (k < n) {
    const d = line.charCodeAt(k);
    if (d !== 32 && d !== 9) break;
    k++;
  }
  return k === n ? 0 : depth;
}

/** A heading line's text: after the "#"s and the run of spaces and tabs, without spaces and tabs at its end. */
function headingText(line, depth) {
  const n = line.length;
  let i = depth;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    i++;
  }
  let end = n;
  while (end > i) {
    const c = line.charCodeAt(end - 1);
    if (c !== 32 && c !== 9) break;
    end--;
  }
  return i === 0 && end === n ? line : line.slice(i, end);
}

/** Whether `line` is a thematic break: "---" or "***", then spaces or tabs only. */
function isHr(line) {
  const n = line.length;
  if (n < 3) return false;
  const a = line.charCodeAt(0);
  if (a !== 45 && a !== 42) return false;
  if (line.charCodeAt(1) !== a || line.charCodeAt(2) !== a) return false;
  for (let k = 3; k < n; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a thematic break — kinds 1 to 4 of the seven. */
function endsParagraph(line) {
  const kind = lineKind(line);
  return kind !== LINE_TEXT && kind <= LINE_HR;
}

/** Where a bullet item's text starts (2), or -1. */
function bulletContentStart(line) {
  if (line.length >= 2) {
    const c = line.charCodeAt(0);
    if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return 2;
  }
  return -1;
}

/** Where an ordered item's text starts, or -1: 1 to 9 digits, ".", " ". */
function orderedContentStart(line) {
  const n = line.length;
  let k = 0;
  while (k < n && k <= 9) {
    const c = line.charCodeAt(k);
    if (c < 48 || c > 57) break;
    k++;
  }
  if (k === 0 || k > 9) return -1;
  if (line.charCodeAt(k) !== 46 || line.charCodeAt(k + 1) !== 32) return -1;
  return k + 2;
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  const n = line.length;
  if (n < 3) return false;
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let k = 2;
  while (k < n && line.charCodeAt(k) === 32) k++;
  if (k === n) return false;
  return !isSpaceCode(line.charCodeAt(k));
}

/** Whether `s` holds a whitespace character (JavaScript's \s). */
function hasWhitespace(s) {
  const n = s.length;
  for (let i = 0; i < n; i++) if (WHITESPACE[s.charCodeAt(i)] === 1) return true;
  return false;
}

/** The first index in `s` from `from` before `to` where it holds `code` outside a backslash escape, or -1. */
function findUnescaped(s, from, to, code) {
  for (let j = from; j < to; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      const d = j + 1 < to ? s.charCodeAt(j + 1) : -1;
      if (ESCAPABLE[d] === 1) {
        j++;
        continue;
      }
    }
    if (c === code) return j;
  }
  return -1;
}

/**
 * The first "**" in `s` from `from` before `to` outside a backslash escape, or -1. A search that found none after
 * `from` marks that in `memo`, since a later search from any further index of the same or a shorter range finds none
 * either.
 */
function findDoubleStar(s, from, to, memo) {
  if (memo.doubleTo >= to && from >= memo.doubleFrom) return -1;
  for (let j = from; j < to - 1; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      const d = j + 1 < to ? s.charCodeAt(j + 1) : -1;
      if (ESCAPABLE[d] === 1) {
        j++;
        continue;
      }
    }
    if (c === 42 && s.charCodeAt(j + 1) === 42) return j;
  }
  memo.doubleFrom = from;
  memo.doubleTo = to;
  return -1;
}

/** The first single "*" in `s` from `from` before `to` (its run is not "**"), outside an escape, or -1. */
function findSingleStar(s, from, to, memo) {
  if (memo.singleTo >= to && from >= memo.singleFrom) return -1;
  for (let j = from; j < to; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      const d = j + 1 < to ? s.charCodeAt(j + 1) : -1;
      if (ESCAPABLE[d] === 1) {
        j++;
        continue;
      }
    }
    if (c !== 42) continue;
    if (j + 1 < to && s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  memo.singleFrom = from;
  memo.singleTo = to;
  return -1;
}

/**
 * `s` from `from` to `to` rendered inline; `link` is a link target's href. Runs of ordinary characters are copied, never
 * escaped, and what a run of markup holds is rendered in place — the same string and bounds, no copy per nesting — so a
 * body is scanned once rather than once per level.
 */
function inlineRange(s, from, to, link, memo) {
  let out = '';
  let i = from;
  while (i < to) {
    let j = i;
    while (j < to && (SPECIAL[s.charCodeAt(j)] & 1) === 0) j++;
    if (j > i) {
      if (j === to && i === from) return from === 0 && to === s.length ? s : s.slice(from, to);
      out += s.slice(i, j);
      i = j;
      if (i >= to) break;
    }
    const c = s.charCodeAt(i);
    switch (c) {
      case 42: {
        if (i + 1 < to && s.charCodeAt(i + 1) === 42) {
          const close = findDoubleStar(s, i + 2, to, memo);
          if (close > i + 2) {
            out += '<strong>';
            out += inlineRange(s, i + 2, close, link, memo);
            out += '</strong>';
            i = close + 2;
          } else {
            out += '**';
            i += 2;
          }
          continue;
        }
        const close = findSingleStar(s, i + 1, to, memo);
        if (close > i + 1) {
          out += '<em>';
          out += inlineRange(s, i + 1, close, link, memo);
          out += '</em>';
          i = close + 1;
        } else {
          out += '*';
          i++;
        }
        continue;
      }
      case 91: {
        const bracket = findUnescaped(s, i + 1, to, 93);
        let paren = -1;
        if (bracket !== -1 && bracket + 1 < to && s.charCodeAt(bracket + 1) === 40) {
          const found = s.indexOf(')', bracket + 2);
          if (found !== -1 && found < to) paren = found;
        }
        if (paren !== -1) {
          const target = s.slice(bracket + 2, paren);
          if (target !== '' && !hasWhitespace(target)) {
            out += `<a href="${escapeHtml(link(target))}">`;
            out += inlineRange(s, i + 1, bracket, link, memo);
            out += '</a>';
            i = paren + 1;
            continue;
          }
        }
        out += '[';
        i++;
        continue;
      }
      case 92: {
        const d = i + 1 < to ? s.charCodeAt(i + 1) : -1;
        if (ESCAPABLE[d] === 1) {
          out += s[i + 1];
          i += 2;
        } else {
          out += '\\';
          i++;
        }
        continue;
      }
      case 96: {
        const found = s.indexOf('`', i + 1);
        if (found > i + 1 && found < to) {
          out += '<code>';
          out += escapeHtml(s.slice(i + 1, found));
          out += '</code>';
          i = found + 1;
        } else {
          out += '`';
          i++;
        }
        continue;
      }
      default:
        out += c === 38 ? AMP : c === 60 ? LT : c === 62 ? GT : c === 34 ? QUOT : APOS;
        i++;
    }
  }
  return out;
}

/** `s` rendered inline; `link` is a link target's href. */
function inline(s, link) {
  return inlineRange(s, 0, s.length, link, { singleFrom: 0, singleTo: -1, doubleFrom: 0, doubleTo: -1 });
}

/**
 * `src` rendered into `out` (a source or a holder): its html (a "\n" after each block), its toc (every level 2 and 3
 * heading) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, link, out) {
  const lines = src.split('\n');
  const count = lines.length;
  let ids = null;
  let toc = [];
  let excerpt = null;
  const html = [];
  let i = 0;
  while (i < count) {
    const line = lines[i];
    const kind = lineKind(line);
    if (kind === LINE_BLANK) {
      i++;
      continue;
    }
    if (kind === LINE_FENCE) {
      const langEnd = fenceOpenLang(line);
      const body = [];
      i++;
      while (i < count && !isFenceClose(lines[i])) {
        body.push(escapeHtml(lines[i]), '\n');
        i++;
      }
      i++;
      const cls = langEnd === 3 ? '' : ` class="language-${escapeHtml(line.slice(3, langEnd))}"`;
      html.push('<pre><code', cls, '>', body.join(''), '</code></pre>\n');
      continue;
    }
    if (kind === LINE_HEADING) {
      const depth = headingOf(line);
      const text = headingText(line, depth);
      const slug = slugify(text);
      let id = slug;
      if (ids === null) ids = new Set();
      if (ids.has(id)) {
        let k = 2;
        do {
          id = `${slug}-${k}`;
          k++;
        } while (ids.has(id));
      }
      ids.add(id);
      const rendered = inline(text, link);
      const tag = `h${depth}`;
      html.push('<', tag, ' id="', id, '">', rendered, '</', tag, '>\n');
      if (depth === 2 || depth === 3) toc.push({ level: depth, id, html: rendered });
      i++;
      continue;
    }
    if (kind === LINE_HR) {
      html.push('<hr>\n');
      i++;
      continue;
    }
    if (kind === LINE_QUOTE) {
      const body = [];
      while (i < count && lines[i].charCodeAt(0) === 62) {
        const raw = lines[i];
        const kept = trimLine(raw.slice(raw.charCodeAt(1) === 32 ? 2 : 1));
        if (kept !== '') {
          if (body.length !== 0) body.push('\n');
          body.push(kept);
        }
        i++;
      }
      if (body.length === 0) html.push('<blockquote>\n</blockquote>\n');
      else html.push('<blockquote>\n<p>', inline(body.join(''), link), '</p>\n</blockquote>\n');
      continue;
    }
    if (kind === LINE_BULLET || kind === LINE_ORDERED) {
      const isOrdered = kind === LINE_ORDERED;
      let start = 1;
      if (isOrdered) {
        let digits = 0;
        while (digits < line.length && line.charCodeAt(digits) >= 48 && line.charCodeAt(digits) <= 57) digits++;
        start = Number(line.slice(0, digits));
      }
      const items = [];
      while (i < count) {
        const next = lines[i];
        const at = isOrdered ? orderedContentStart(next) : bulletContentStart(next);
        if (at !== -1) {
          items.push(trimLine(next.slice(at)));
          i++;
        } else if (isContinued(next)) {
          items[items.length - 1] += `\n${trimLine(next)}`;
          i++;
        } else break;
      }
      html.push(isOrdered ? (start !== 1 ? `<ol start="${start}">\n` : '<ol>\n') : '<ul>\n');
      for (let k = 0; k < items.length; k++) html.push('<li>', inline(items[k], link), '</li>\n');
      html.push(isOrdered ? '</ol>\n' : '</ul>\n');
      continue;
    }
    const text = [trimLine(line)];
    i++;
    while (i < count && !endsParagraph(lines[i])) {
      text.push('\n', trimLine(lines[i]));
      i++;
    }
    const rendered = inline(text.length === 1 ? text[0] : text.join(''), link);
    if (excerpt === null) excerpt = rendered;
    html.push('<p>', rendered, '</p>\n');
  }
  out.html = html.join('');
  out.toc = toc;
  out.excerpt = excerpt ?? '';
}

// ---------------------------------------------------------------- templates

const PATH_TEXT = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_TEXT = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_TEXT = /^if (not )?(\S+)$/;
const INCLUDE_TEXT = /^include "([a-z0-9-]+)"$/;

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** The node kinds, as small integers: rendering dispatches on these. */
const KIND_TEXT = 0;
const KIND_VAR = 1;
const KIND_RAW = 2;
const KIND_IF = 3;
const KIND_FOR = 4;
const KIND_INCLUDE = 5;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_TEXT.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `src` from `a` to `b` is spaces and tabs only. */
function blankRange(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  const n = src.length;
  let text = '';
  let i = 0;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
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
    const standalone = blankRange(src, lineStart, open) && blankRange(src, end, nl === -1 ? n : nl);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** Whether `nodes` reads `loop` here: an include renders in the same scope, so it may read it too. */
function readsLoop(nodes) {
  for (let k = 0; k < nodes.length; k++) {
    const n = nodes[k];
    const kind = n.kind;
    if (kind === KIND_VAR || kind === KIND_RAW) {
      if (n.path[0] === 'loop') return true;
    } else if (kind === KIND_IF) {
      if (n.path[0] === 'loop' || readsLoop(n.then) || (n.else !== null && readsLoop(n.else))) return true;
    } else if (kind === KIND_INCLUDE) return true;
  }
  return false;
}

/** Each for node's body: whether it reads `loop`, which is the only case the loop object has to be built. */
function annotateLoops(nodes) {
  for (let k = 0; k < nodes.length; k++) {
    const n = nodes[k];
    if (n.kind === KIND_FOR) {
      n.usesLoop = readsLoop(n.body);
      annotateLoops(n.body);
    } else if (n.kind === KIND_IF) {
      annotateLoops(n.then);
      if (n.else !== null) annotateLoops(n.else);
    }
  }
}

/** The names every build has from the start: a template reading only these (and its own loop variables) is a constant. */
const SITE_SCOPED = ['site', 'tags', 'recent'];

/**
 * Whether `nodes` can only ever render the same text for one build: every name they read is either one of `allowed`
 * (the build's own names and the loop variables around them) or a path into such a value, with the templates they
 * include collected into `includes`.
 */
function readsSiteOnly(nodes, includes, allowed) {
  for (let k = 0; k < nodes.length; k++) {
    const node = nodes[k];
    const kind = node.kind;
    if (kind === KIND_TEXT) continue;
    if (kind === KIND_INCLUDE) includes.push(node.name);
    else {
      if (!allowed.includes(node.path[0])) return false;
      if (kind === KIND_IF) {
        if (!readsSiteOnly(node.then, includes, allowed)) return false;
        if (node.else !== null && !readsSiteOnly(node.else, includes, allowed)) return false;
      } else if (kind === KIND_FOR && !readsSiteOnly(node.body, includes, allowed.concat(node.name, 'loop'))) return false;
    }
  }
  return true;
}

/** Each include node: its template's own include nesting when that text is the build's for every page, else 0. */
function annotateCached(nodes, chainOf) {
  for (let k = 0; k < nodes.length; k++) {
    const node = nodes[k];
    const kind = node.kind;
    if (kind === KIND_INCLUDE) node.chain = chainOf.get(node.name) ?? 0;
    else if (kind === KIND_IF) {
      annotateCached(node.then, chainOf);
      if (node.else !== null) annotateCached(node.else, chainOf);
    } else if (kind === KIND_FOR) annotateCached(node.body, chainOf);
  }
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  const tokens = tokenize(name, src);
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    if (tok.t === 'text') {
      body.push({ kind: KIND_TEXT, text: tok.text });
      continue;
    }
    if (tok.t === 'var' || tok.t === 'raw') {
      body.push({ kind: tok.t === 'var' ? KIND_VAR : KIND_RAW, path: tok.path });
      continue;
    }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_TEXT.exec(tag)) !== null) {
      const node = { kind: KIND_FOR, name: m[1], path: pathOf(name, m[2]), body: [], usesLoop: false };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF_TEXT.exec(tag)) !== null) {
      const node = { kind: KIND_IF, not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== KIND_IF || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.else = [];
      body = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.kind !== (tag === 'endfor' ? KIND_FOR : KIND_IF)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === KIND_FOR ? parent.body : parent.else ?? parent.then;
    } else if ((m = INCLUDE_TEXT.exec(tag)) !== null) body.push({ kind: KIND_INCLUDE, name: m[1] });
    else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
  }
  if (stack.length > 1) {
    const top = stack[stack.length - 1];
    throw new TemplateError(`template "${name}": a ${top.kind === KIND_FOR ? 'for' : top.kind === KIND_IF ? 'if' : 'root'} is not closed`);
  }
  annotateLoops(root.body);
  return root.body;
}

/**
 * The value at `path` in the scope stack: its first name from the nearest scope holding it, then own properties of the
 * value. A scope never holds an undefined value of its own, so a plain read finds the nearest one — no `Object.hasOwn`
 * on the hot path — and only the steps after the first, which walk values a template built, are checked.
 */
function lookup(ctx, path) {
  const stack = ctx.stack;
  const first = path[0];
  let vars = null;
  for (let k = ctx.depth - 1; k >= 0; k--) {
    const v = stack[k];
    if (v[first] !== undefined) {
      vars = v;
      break;
    }
  }
  if (vars === null) return undefined;
  let value = vars[first];
  for (let k = 1; k < path.length; k++) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, path[k])) return undefined;
    value = value[path[k]];
  }
  return value;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let k = 0; k < v.length; k++) {
      if (k !== 0) out += ', ';
      out += textOf(v[k]);
    }
    return out;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "" or 0, and not an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in the scope stack `ctx` holds at its current depth, one piece pushed onto `sink` per node. */
function renderNodes(nodes, ctx, depth, sink) {
  for (let k = 0; k < nodes.length; k++) {
    const node = nodes[k];
    switch (node.kind) {
      case KIND_TEXT:
        sink.push(node.text);
        break;
      case KIND_VAR: {
        const value = lookup(ctx, node.path);
        sink.push(typeof value === 'string' ? escapeHtml(value) : textOf(value));
        break;
      }
      case KIND_RAW:
        sink.push(textOf(lookup(ctx, node.path)));
        break;
      case KIND_FOR: {
        const xs = lookup(ctx, node.path);
        if (!Array.isArray(xs)) break;
        const name = node.name;
        const stack = ctx.stack;
        const at = ctx.depth;
        const total = xs.length;
        if (node.usesLoop) {
          for (let e = 0; e < total; e++) {
            const vars = {};
            vars[name] = xs[e];
            vars.loop = { index: e + 1, first: e === 0, last: e === total - 1, length: total };
            stack[at] = vars;
            ctx.depth = at + 1;
            renderNodes(node.body, ctx, depth, sink);
          }
        } else {
          for (let e = 0; e < total; e++) {
            const vars = {};
            vars[name] = xs[e];
            stack[at] = vars;
            ctx.depth = at + 1;
            renderNodes(node.body, ctx, depth, sink);
          }
        }
        ctx.depth = at;
        break;
      }
      case KIND_IF: {
        const branch = truthy(lookup(ctx, node.path)) !== node.not ? node.then : node.else;
        if (branch !== null) renderNodes(branch, ctx, depth, sink);
        break;
      }
      default: {
        if (depth >= INCLUDE_DEPTH) break;
        const chain = node.chain;
        if (chain === 0 || depth + chain > INCLUDE_DEPTH) {
          const included = ctx.templates.get(node.name);
          if (included !== undefined) renderNodes(included, ctx, depth + 1, sink);
          break;
        }
        // The same text on every page of this build, so it is built once and pushed whole from then on.
        let text = ctx.cached.get(node.name);
        if (text === undefined) {
          const pieces = [];
          renderNodes(ctx.templates.get(node.name), ctx, 0, pieces);
          text = pieces.join('');
          ctx.cached.set(node.name, text);
        }
        sink.push(text);
      }
    }
  }
}

// ---------------------------------------------------------------- the build

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];
const KEYSET = { title: 1, date: 1, tags: 1, draft: 1, layout: 1, slug: 1, summary: 1 };

/** Set by a value rule that refuses its key, and read by the front matter loop. */
let fmIssue = '';

/** The directory a path is in, "" at the root. */
function dirOf(path) {
  const k = path.lastIndexOf('/');
  return k === -1 ? '' : path.slice(0, k);
}

/** `rel` from the directory `dir`, or null when it climbs out of the root: `dir`'s own segments are only ever cut
 * short here, so neither a split nor a join is needed to walk them. */
function resolvePath(dir, rel) {
  let end = dir.length;
  let own = null;
  const n = rel.length;
  let i = 0;
  while (i < n) {
    const brk = rel.indexOf('/', i);
    const segEnd = brk === -1 ? n : brk;
    const seg = rel.slice(i, segEnd);
    if (seg === '..') {
      if (own !== null && own.length !== 0) own.pop();
      else if (end === 0) return null;
      else {
        const cut = dir.lastIndexOf('/', end - 1);
        end = cut === -1 ? 0 : cut;
      }
    } else if (seg !== '' && seg !== '.') {
      if (own === null) own = [];
      own.push(seg);
    }
    i = segEnd + 1;
  }
  const prefix = end === 0 ? '' : dir.slice(0, end);
  if (own === null) return prefix;
  const tail = own.join('/');
  return prefix === '' ? tail : `${prefix}/${tail}`;
}

/** Whether `y`-`m`-`d` is a real day (1970-01-01 to 2099-12-31). */
function isRealDay(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return false;
  let days;
  if (m === 2) days = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  else days = m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
  return d <= days;
}

/** A string value: "..." with \" and \\ its only escapes, or bare (never opening on " or [). */
function stringValue(key, raw) {
  const n = raw.length;
  if (raw.charCodeAt(0) === 34) {
    if (n < 2 || raw.charCodeAt(n - 1) !== 34) return void (fmIssue = `key "${key}": a quoted string is not closed`);
    let out = '';
    for (let i = 1; i < n - 1; i++) {
      const c = raw.charCodeAt(i);
      if (c === 92) {
        const d = i + 1 < n ? raw.charCodeAt(i + 1) : -1;
        if ((d !== 34 && d !== 92) || i + 1 === n - 1) return void (fmIssue = `key "${key}": a quoted string holds an escape other than \\" or \\\\`);
        out += raw[i + 1];
        i++;
      } else if (c === 34) return void (fmIssue = `key "${key}": a quoted string holds a stray quote`);
      else out += raw[i];
    }
    return out;
  }
  if (raw.charCodeAt(0) === 91) return void (fmIssue = `key "${key}": a bare string opens on [`);
  return raw;
}

/** Whether `raw` is a template name: a-z, 0-9 and "-". */
function isTemplateName(raw) {
  const n = raw.length;
  if (n === 0) return false;
  for (let i = 0; i < n; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `raw` is a slug: a-z and 0-9 parts joined by single "-", 64 characters at most. */
function isSlug(raw) {
  const n = raw.length;
  if (n === 0 || n > SLUG_MAX) return false;
  let i = 0;
  while (i < n) {
    const start = i;
    while (i < n) {
      const c = raw.charCodeAt(i);
      if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) i++;
      else break;
    }
    if (i === start) return false;
    if (i === n) return true;
    if (raw.charCodeAt(i) !== 45) return false;
    i++;
  }
  return false;
}

/** Whether `name` is a tag name: not empty, and holding no ", [ or ]. */
function isTagName(name) {
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c === 34 || c === 91 || c === 93) return false;
  }
  return true;
}

/** One key's value (setting fmIssue to why it is refused). */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary':
      return stringValue(key, raw);
    case 'date': {
      if (raw.length !== 10) return void (fmIssue = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)');
      for (let i = 0; i < 10; i++) {
        const c = raw.charCodeAt(i);
        if (i === 4 || i === 7) {
          if (c !== 45) return void (fmIssue = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)');
        } else if (c < 48 || c > 57) return void (fmIssue = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)');
      }
      const y = Number(raw.slice(0, 4));
      const m = Number(raw.slice(5, 7));
      const d = Number(raw.slice(8, 10));
      if (y < 1970 || y > 2099 || !isRealDay(y, m, d)) return void (fmIssue = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)');
      return raw;
    }
    case 'tags': {
      const n = raw.length;
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(n - 1) !== 93) return void (fmIssue = 'key "tags": not a list [a, b]');
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return [];
      const parts = inner.split(',');
      const out = [];
      for (let i = 0; i < parts.length; i++) {
        const name = parts[i].trim();
        if (name === '' || !isTagName(name)) return void (fmIssue = 'key "tags": an empty tag, or one holding " [ or ]');
        out.push(name);
      }
      return out;
    }
    case 'draft':
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      return void (fmIssue = 'key "draft": true or false');
    case 'layout':
      return isTemplateName(raw) ? raw : void (fmIssue = 'key "layout": not a template name');
    default:
      return isSlug(raw) ? raw : void (fmIssue = 'key "slug": not a slug');
  }
}

/** A source's front matter and body, written to `out`: "" or the first reason it is refused. */
function parseFrontMatter(text, out) {
  const n = text.length;
  if (!(n >= 3 && text.charCodeAt(0) === 45 && text.charCodeAt(1) === 45 && text.charCodeAt(2) === 45 && (n === 3 || text.charCodeAt(3) === 10))) {
    return 'no front matter';
  }
  let closeStart = -1;
  let closeEnd = -1;
  let p = 4;
  while (p <= n) {
    const nl = text.indexOf('\n', p);
    const lineEnd = nl === -1 ? n : nl;
    if (lineEnd - p === 3 && text.charCodeAt(p) === 45 && text.charCodeAt(p + 1) === 45 && text.charCodeAt(p + 2) === 45) {
      closeStart = p;
      closeEnd = lineEnd;
      break;
    }
    if (nl === -1) break;
    p = nl + 1;
  }
  if (closeStart === -1) return 'the front matter is not closed';
  const data = { title: undefined, summary: undefined, date: undefined, tags: undefined, draft: undefined, layout: undefined, slug: undefined };
  let at = 4;
  let lineNo = 1;
  while (at < closeStart) {
    const nl = text.indexOf('\n', at);
    const lineEnd = nl === -1 || nl > closeStart ? closeStart : nl;
    const line = text.slice(at, lineEnd);
    at = lineEnd + 1;
    lineNo++;
    const ln = line.length;
    let e = 0;
    while (e < ln) {
      const c = line.charCodeAt(e);
      if (c !== 32 && c !== 9) break;
      e++;
    }
    if (e === ln) continue;
    if (line.charCodeAt(0) === 35) continue;
    e = 0;
    while (e < ln) {
      const c = line.charCodeAt(e);
      if ((c >= 97 && c <= 122) || c === 95) e++;
      else break;
    }
    if (e === 0 || e >= ln || line.charCodeAt(e) !== 58) return `line ${lineNo} is not "key: value"`;
    const key = line.slice(0, e);
    let raw;
    if (e + 1 === ln) raw = '';
    else if (line.charCodeAt(e + 1) === 32) {
      let end = ln;
      while (end > e + 2) {
        const c = line.charCodeAt(end - 1);
        if (c !== 32 && c !== 9) break;
        end--;
      }
      raw = end <= e + 2 ? '' : line.slice(e + 2, end);
    } else return `line ${lineNo} is not "key: value"`;
    if (KEYSET[key] !== 1) return `unknown key "${key}"`;
    if (data[key] !== undefined) return `key "${key}" is given twice`;
    if (raw === '') return `key "${key}" has no value`;
    fmIssue = '';
    const value = valueOf(key, raw);
    if (fmIssue !== '') return fmIssue;
    data[key] = value;
  }
  if (data.title === undefined) return 'no title';
  out.data = data;
  out.body = closeEnd >= n ? '' : text.slice(closeEnd + 1);
  return '';
}

/** One site's output tree: path -> text. */
export function run(input) {
  const report = [];
  const broken = new Set();
  const brokenLines = [];

  // 1. Templates, in code-unit order of their names; one that does not parse is reported and left out.
  const templates = new Map();
  const names = Object.keys(input.templates).sort();
  for (let k = 0; k < names.length; k++) {
    const name = names[k];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1b. Which templates render the same text on every page of this build (they read only site, tags and recent, and so
  // does everything they include), and how deep each one's own includes nest, so an include of one is built once.
  const chainOf = new Map();
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, nodes] of templates) {
      if (chainOf.has(name)) continue;
      const includes = [];
      if (!readsSiteOnly(nodes, includes, SITE_SCOPED)) continue;
      let chain = 1;
      let ok = true;
      for (let k = 0; k < includes.length; k++) {
        const nested = chainOf.get(includes[k]);
        if (nested === undefined) {
          if (templates.has(includes[k])) ok = false;
        } else if (nested >= chain) chain = nested + 1;
      }
      if (!ok) continue;
      chainOf.set(name, chain);
      grew = true;
    }
  }
  for (const [name, nodes] of templates) annotateCached(nodes, chainOf);

  // 2. The sources, in code-unit order of their paths; any other file is static.
  const files = input.files.slice();
  files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  const sources = [];
  const statics = [];
  for (let k = 0; k < files.length; k++) {
    const f = files[k];
    const path = f.path;
    if (path.charCodeAt(path.length - 3) === 46 && path.charCodeAt(path.length - 2) === 109 && path.charCodeAt(path.length - 1) === 100) {
      const content = f.content;
      const text = content.indexOf('\r') === -1 ? content : content.replace(/\r\n?/g, '\n');
      sources.push({
        path,
        text,
        data: undefined,
        body: '',
        post: false,
        layout: '',
        slug: '',
        outDir: '',
        url: '',
        html: '',
        toc: null,
        excerpt: '',
        tagRefs: null,
        card: null,
        newer: null,
        older: null,
      });
    } else statics.push({ path, content: f.content });
  }

  // 3. Front matter, then the reserved directory, post date, layout and draft checks.
  const kept = [];
  for (let k = 0; k < sources.length; k++) {
    const s = sources[k];
    const path = s.path;
    const issue = parseFrontMatter(s.text, s);
    if (issue !== '') {
      report.push(`refused ${path}: ${issue}`);
      continue;
    }
    s.post = path.charCodeAt(0) === 112 && path.charCodeAt(1) === 111 && path.charCodeAt(2) === 115 && path.charCodeAt(3) === 116 && path.charCodeAt(4) === 115 && path.charCodeAt(5) === 47;
    const own = path.startsWith('tags/') ? 'tags' : path.startsWith('page/') ? 'page' : null;
    if (own !== null) {
      report.push(`refused ${path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && s.data.date === undefined) {
      report.push(`refused ${path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${path}`);
      continue;
    }
    kept.push(s);
  }

  // 4. Permalinks: each slug made unique in its output directory, in source order.
  const takenBy = new Map();
  const byPath = new Map();
  for (let k = 0; k < kept.length; k++) {
    const s = kept[k];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let taken = takenBy.get(dir);
    if (taken === undefined) {
      taken = dir === '' ? new Set(RESERVED) : new Set();
      takenBy.set(dir, taken);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), taken);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    byPath.set(s.path, s);
  }

  // 5. Markdown, each body's links resolved to the pages and static files they name.
  const staticPath = new Set();
  for (let k = 0; k < statics.length; k++) staticPath.add(statics[k].path);
  let fromPath = '';
  let fromDir = '';
  const link = (target) => {
    const first = target.charCodeAt(0);
    if (first === 47 || first === 35) return target;
    if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      let j = 1;
      while (j < target.length) {
        const c = target.charCodeAt(j);
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45) j++;
        else break;
      }
      if (target.charCodeAt(j) === 58) return target;
    }
    const hash = target.indexOf('#');
    const rel = hash === -1 ? target : target.slice(0, hash);
    const frag = hash === -1 ? '' : target.slice(hash);
    const path = rel === '' ? null : resolvePath(fromDir, rel);
    if (path !== null) {
      const page = byPath.get(path);
      if (page !== undefined) return `${page.url}${frag}`;
      if (staticPath.has(path)) return `${base}/${path}${frag}`;
    }
    const line = `broken-link ${fromPath} -> ${target}`;
    if (!broken.has(line)) {
      broken.add(line);
      brokenLines.push(line);
    }
    return target;
  };
  for (let k = 0; k < kept.length; k++) {
    const s = kept[k];
    fromPath = s.path;
    fromDir = dirOf(s.path);
    renderMarkdown(s.body, link, s);
  }

  // 6. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = [];
  for (let k = 0; k < kept.length; k++) if (kept[k].post) posts.push(kept[k]);
  posts.sort((x, y) => {
    const a = x.data.date;
    const b = y.data.date;
    if (a !== b) return a < b ? 1 : -1;
    const p = x.slug;
    const q = y.slug;
    return p < q ? -1 : p > q ? 1 : 0;
  });
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 7. The tags, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  for (let k = 0; k < posts.length; k++) {
    const p = posts[k];
    const names = p.data.tags ?? [];
    const refs = [];
    p.tagRefs = refs;
    let seen = null;
    for (let j = 0; j < names.length; j++) {
      const slug = slugify(names[j]);
      if (seen === null) seen = new Set();
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name: names[j], slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      refs.push(tag);
    }
  }
  for (let k = 0; k < kept.length; k++) {
    const s = kept[k];
    if (s.post) continue;
    const names = s.data.tags ?? [];
    const refs = [];
    let seen = null;
    for (let j = 0; j < names.length; j++) {
      const slug = slugify(names[j]);
      if (seen === null) seen = new Set();
      if (seen.has(slug)) continue;
      seen.add(slug);
      const tag = bySlug.get(slug);
      refs.push(tag !== undefined ? tag : { name: names[j], slug, url: '', posts: [] });
    }
    s.tagRefs = refs;
  }
  const tags = [...bySlug.values()].sort((x, y) => (y.posts.length - x.posts.length) || (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));

  // 8. Every page through its layout, the index pages and the tag pages through theirs.
  for (let k = 0; k < kept.length; k++) {
    const s = kept[k];
    const refs = s.tagRefs;
    let tagCards = null;
    if (refs.length !== 0) {
      tagCards = [];
      for (let j = 0; j < refs.length; j++) tagCards.push({ name: refs[j].name, slug: refs[j].slug, url: refs[j].url });
    } else tagCards = [];
    const date = s.data.date;
    s.card = {
      title: s.data.title,
      url: s.url,
      date: date ?? '',
      date_long: date === undefined ? '' : longDate(date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: tagCards,
    };
  }
  const siteVars = { title: input.site.title, base_url: base };
  const allTags = [];
  for (let k = 0; k < tags.length; k++) allTags.push({ name: tags[k].name, slug: tags[k].slug, url: tags[k].url, count: tags[k].posts.length });
  const recent = [];
  for (let k = 0; k < posts.length && k < input.site.recent; k++) recent.push(posts[k].card);
  const ctx = { templates, stack: [], depth: 0, cached: new Map() };
  const render = (name, page, list, pager, tag) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const vars = { site: siteVars, tags: allTags, recent };
    if (page !== undefined) vars.page = page;
    if (list !== undefined) vars.posts = list;
    if (pager !== undefined) vars.pager = pager;
    if (tag !== undefined) vars.tag = tag;
    ctx.stack[0] = vars;
    ctx.depth = 1;
    const sink = [];
    renderNodes(nodes, ctx, 0, sink);
    return sink.length === 1 ? sink[0] : sink.join('');
  };
  const output = {};
  for (let k = 0; k < kept.length; k++) {
    const s = kept[k];
    const card = s.card;
    const newer = s.newer;
    const older = s.older;
    const page = {
      title: card.title,
      url: card.url,
      date: card.date,
      date_long: card.date_long,
      summary: card.summary,
      excerpt: card.excerpt,
      reading_minutes: card.reading_minutes,
      tags: card.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: newer === null ? null : { title: newer.data.title, url: newer.url, date: newer.data.date ?? '', date_long: newer.data.date === undefined ? '' : longDate(newer.data.date) },
      older: older === null ? null : { title: older.data.title, url: older.url, date: older.data.date ?? '', date_long: older.data.date === undefined ? '' : longDate(older.data.date) },
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, page, undefined, undefined, undefined);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const slice = [];
    for (let j = (k - 1) * per; j < k * per && j < posts.length; j++) slice.push(posts[j].card);
    const pager = { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) };
    const html = render('index', undefined, slice, pager, undefined);
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let k = 0; k < tags.length; k++) {
    const tag = tags[k];
    const tagCards = [];
    for (let j = 0; j < tag.posts.length; j++) tagCards.push(tag.posts[j].card);
    const html = render('tag', undefined, undefined, undefined, { name: tag.name, slug: tag.slug, url: tag.url, count: tag.posts.length, posts: tagCards });
    if (html !== null) output[`tags/${tag.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', undefined, undefined, undefined, undefined);
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let k = 0; k < statics.length; k++) {
    const f = statics[k];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 9. The report.
  const lines = report.concat(brokenLines).sort();
  let pageCount = 0;
  for (let k = 0; k < kept.length; k++) if (!kept[k].post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
