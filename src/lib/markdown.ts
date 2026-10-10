// Markdown for cloud bodies. The text is the presenter's, shown to everyone, so it is rendered with raw HTML switched off and
// then sanitised again with an allow-list: https links and images only, nothing that can run script.
import type MarkdownItClass from 'markdown-it';

type MarkdownIt = InstanceType<typeof MarkdownItClass>;

const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'em', 's', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'hr', 'a', 'img',
  'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
]);
const ALLOWED_ATTRS: Record<string, string[]> = { a: ['href', 'title'], img: ['src', 'alt', 'title'], th: ['style'], td: ['style'], ol: ['start'] };
const ALIGN = /^text-align:\s*(left|right|center)$/;
const HTTPS = /^https:\/\//i;

let renderer: Promise<MarkdownIt> | null = null;

function load(): Promise<MarkdownIt> {
  renderer ??= import('markdown-it')
    .then(({ default: MarkdownIt }) => {
      const md = new MarkdownIt({ html: false, linkify: false, breaks: true });
      // One page, one h1, and no skipped levels: the body's highest heading becomes h2 and the rest keep their
      // distance from it (capped at h6).
      md.core.ruler.push('shift_headings', (state) => {
        const headings = state.tokens.filter((t) => (t.type === 'heading_open' || t.type === 'heading_close') && /^h[1-6]$/.test(t.tag));
        if (headings.length === 0) return;
        const shift = 2 - Math.min(...headings.map((t) => Number(t.tag[1])));
        for (const token of headings) token.tag = `h${Math.min(6, Number(token.tag[1]) + shift)}`;
      });
      return md;
    })
    .catch((error) => {
      // A failed chunk load (say an old page after a deploy) is not remembered, so the next render tries again.
      renderer = null;
      throw error;
    });
  return renderer;
}

/**
 * The first line of a markdown body as plain words, for compact lists and screen-reader announcements: link and image
 * text without the URL, no heading, quote or list markers, and emphasis characters removed without adding spaces (so
 * "well-known" and "**great**?" read naturally). Rules and table separator lines are skipped.
 */
export function plainLine(md: string): string {
  for (const raw of md.split(/\r?\n/)) {
    const line = raw
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s*(?:>\s*)+/, '')
      .replace(/^\s*#{1,6}(?:\s+|$)/, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/[*_`~|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!/^[-=:\s]*$/.test(line)) return line;
  }
  return '';
}

export function plainText(source: string): string {
  return source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Removes everything outside the allow-list. Runs in the browser (DOMParser). */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      walk(child);
      const tag = child.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) {
        child.replaceWith(...Array.from(child.childNodes));
        continue;
      }
      const allowed = ALLOWED_ATTRS[tag] ?? [];
      for (const attr of Array.from(child.attributes)) {
        if (!allowed.includes(attr.name)) child.removeAttribute(attr.name);
      }
      if ((tag === 'th' || tag === 'td') && child.hasAttribute('style') && !ALIGN.test(child.getAttribute('style') ?? '')) child.removeAttribute('style');
      if (tag === 'a') {
        if (HTTPS.test(child.getAttribute('href') ?? '')) {
          child.setAttribute('target', '_blank');
          child.setAttribute('rel', 'noopener noreferrer');
        } else {
          child.replaceWith(...Array.from(child.childNodes));
        }
      }
      // A wide table or code block scrolls sideways inside itself; tabindex lets keyboard users scroll it too.
      if (tag === 'table' || tag === 'pre') child.setAttribute('tabindex', '0');
      if (tag === 'img') {
        if (HTTPS.test(child.getAttribute('src') ?? '')) {
          child.setAttribute('loading', 'lazy');
          child.setAttribute('referrerpolicy', 'no-referrer');
        } else {
          child.replaceWith(doc.createTextNode(child.getAttribute('alt') ?? ''));
        }
      }
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

export async function renderMarkdown(source: string): Promise<string> {
  const md = await load();
  return sanitizeHtml(md.render(source));
}
