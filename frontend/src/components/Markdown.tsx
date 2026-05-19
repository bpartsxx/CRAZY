/**
 * Lightweight Markdown renderer for chat bubbles.
 * Supports the handful of features the LLM actually emits — bold, italic,
 * code, links, lists, blockquotes, headings. No external deps.
 *
 * Output is plain React elements styled via classes (.md-*) in styles.css.
 */
import React from "react";

interface Pattern {
  re: RegExp;
  render: (m: RegExpExecArray, key: string) => React.ReactNode;
}

// Inline rules tried in order of priority. Code first so its contents aren't
// mangled by bold/italic regexes.
const INLINE_PATTERNS: Pattern[] = [
  { re: /`([^`\n]+)`/, render: (m, k) => <code key={k}>{m[1]}</code> },
  { re: /\*\*([^*\n]+)\*\*/, render: (m, k) => <strong key={k}>{renderInline(m[1], k + ".")}</strong> },
  { re: /__([^_\n]+)__/,   render: (m, k) => <strong key={k}>{renderInline(m[1], k + ".")}</strong> },
  { re: /\*([^*\n]+)\*/,   render: (m, k) => <em key={k}>{renderInline(m[1], k + ".")}</em> },
  { re: /(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/, render: (m, k) => <em key={k}>{renderInline(m[1], k + ".")}</em> },
  { re: /~~([^~\n]+)~~/,   render: (m, k) => <s key={k}>{renderInline(m[1], k + ".")}</s> },
  {
    re: /\[([^\]]+)\]\(([^)\s]+)\)/,
    render: (m, k) => (
      <a key={k} href={m[2]} target="_blank" rel="noopener noreferrer">{m[1]}</a>
    ),
  },
];

function renderInline(text: string, keyPrefix = "i"): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let remaining = text;
  let n = 0;
  while (remaining.length > 0) {
    let earliest: { idx: number; len: number; node: React.ReactNode } | null = null;
    for (const p of INLINE_PATTERNS) {
      const m = p.re.exec(remaining);
      if (m && (earliest === null || m.index < earliest.idx)) {
        earliest = {
          idx: m.index,
          len: m[0].length,
          node: p.render(m, `${keyPrefix}${n++}`),
        };
      }
    }
    if (!earliest) { out.push(remaining); break; }
    if (earliest.idx > 0) out.push(remaining.slice(0, earliest.idx));
    out.push(earliest.node);
    remaining = remaining.slice(earliest.idx + earliest.len);
  }
  return out;
}

function joinLines(lines: string[], k: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push(<br key={`${k}-br${i}`} />);
    out.push(<React.Fragment key={`${k}-l${i}`}>{renderInline(line, `${k}-l${i}-`)}</React.Fragment>);
  });
  return out;
}

const HR_RE         = /^\s*[-*_]{3,}\s*$/;
const HEADING_RE    = /^(#{1,6})\s+(.*)$/;
const BLOCKQUOTE    = /^>\s?(.*)$/;
const ULIST_RE      = /^\s*[-*+•]\s+(.*)$/;
const OLIST_RE      = /^\s*(\d+)\.\s+(.*)$/;
const FENCE_RE      = /^```\s*(\w*)\s*$/;
const FENCE_END_RE  = /^```\s*$/;

export function Markdown({ text }: { text: string }) {
  if (!text) return null;
  // Normalize narrow / non-breaking spaces.
  text = text.replace(/[   ]/g, " ");

  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block ```lang ... ```
    const fence = line.match(FENCE_RE);
    if (fence) {
      i++;
      const buf: string[] = [];
      while (i < lines.length && !FENCE_END_RE.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume closing fence
      blocks.push(
        <pre key={k++} className="md-pre" data-lang={fence[1] || undefined}>
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (HR_RE.test(line)) { blocks.push(<hr key={k++} className="md-hr" />); i++; continue; }

    const h = line.match(HEADING_RE);
    if (h) {
      const level = Math.min(h[1].length, 4);
      blocks.push(
        <div key={k++} className={`md-h md-h${level}`}>
          {renderInline(h[2], `h${k}.`)}
        </div>,
      );
      i++; continue;
    }

    if (BLOCKQUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && BLOCKQUOTE.test(lines[i])) {
        buf.push(lines[i].replace(BLOCKQUOTE, "$1"));
        i++;
      }
      blocks.push(<blockquote key={k++} className="md-bq">{joinLines(buf, `bq${k}`)}</blockquote>);
      continue;
    }

    if (ULIST_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && ULIST_RE.test(lines[i])) {
        items.push(lines[i].replace(ULIST_RE, "$1"));
        i++;
      }
      blocks.push(
        <ul key={k++} className="md-ul">
          {items.map((it, j) => <li key={j}>{renderInline(it, `ul${k}-${j}.`)}</li>)}
        </ul>,
      );
      continue;
    }

    if (OLIST_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && OLIST_RE.test(lines[i])) {
        items.push(lines[i].replace(OLIST_RE, "$2"));
        i++;
      }
      blocks.push(
        <ol key={k++} className="md-ol">
          {items.map((it, j) => <li key={j}>{renderInline(it, `ol${k}-${j}.`)}</li>)}
        </ol>,
      );
      continue;
    }

    if (!line.trim()) { i++; continue; }

    // Paragraph — collect contiguous non-block lines.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !HEADING_RE.test(lines[i]) &&
      !BLOCKQUOTE.test(lines[i]) &&
      !ULIST_RE.test(lines[i]) &&
      !OLIST_RE.test(lines[i]) &&
      !HR_RE.test(lines[i]) &&
      !FENCE_RE.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(<p key={k++} className="md-p">{joinLines(para, `p${k}`)}</p>);
  }

  return <>{blocks}</>;
}
