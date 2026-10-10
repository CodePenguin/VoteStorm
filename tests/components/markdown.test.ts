// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderMarkdown, plainLine, plainText, sanitizeHtml } from '@/lib/markdown';

const html = (source: string) => renderMarkdown(source);
const dom = async (source: string) => {
  const root = document.createElement('div');
  root.innerHTML = await html(source);
  return root;
};

describe('renderMarkdown: formatting', () => {
  it('renders emphasis, lists, quotes, code and tables', async () => {
    const root = await dom('**bold** and *italic*\n\n- one\n- two\n\n> quoted\n\n`code`\n\n| a | b |\n| - | - |\n| 1 | 2 |');
    expect(root.querySelector('strong')?.textContent).toBe('bold');
    expect(root.querySelector('em')?.textContent).toBe('italic');
    expect(root.querySelectorAll('li')).toHaveLength(2);
    expect(root.querySelector('blockquote')?.textContent).toContain('quoted');
    expect(root.querySelector('code')?.textContent).toBe('code');
    expect(root.querySelectorAll('td')).toHaveLength(2);
  });
  it('keeps single line breaks', async () => {
    expect((await dom('line one\nline two')).querySelector('br')).not.toBeNull();
  });
  it('shifts headings down one level so the page keeps one h1', async () => {
    const root = await dom('# Big\n## Medium\n###### Small');
    expect(root.querySelector('h1')).toBeNull();
    expect(root.querySelector('h2')?.textContent).toBe('Big');
    expect(root.querySelector('h3')?.textContent).toBe('Medium');
    expect(root.querySelector('h6')?.textContent).toBe('Small');
  });
  it('makes the body\'s highest heading an h2, so a body that starts at ## or ### skips no level', async () => {
    const fromTwo = await dom('## Top\n### Under');
    expect(fromTwo.querySelector('h2')?.textContent).toBe('Top');
    expect(fromTwo.querySelector('h3')?.textContent).toBe('Under');
    const fromThree = await dom('### Top\n\ntext\n\n#### Under\n\n### Again');
    expect(Array.from(fromThree.querySelectorAll('h2')).map((h) => h.textContent)).toEqual(['Top', 'Again']);
    expect(fromThree.querySelector('h3')?.textContent).toBe('Under');
    expect(fromThree.querySelector('h4')).toBeNull();
  });
  it('does not let a later render inherit an earlier body\'s heading level', async () => {
    expect((await dom('#### Deep')).querySelector('h2')?.textContent).toBe('Deep');
    expect((await dom('# Big')).querySelector('h2')?.textContent).toBe('Big');
  });
});

describe('renderMarkdown: links and images', () => {
  it('opens https links in a new tab without leaking the opener or referrer', async () => {
    const a = (await dom('[site](https://example.com/page)')).querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://example.com/page');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });
  it('renders https images lazily with no referrer and their alt text', async () => {
    const img = (await dom('![A cat](https://example.com/cat.png)')).querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://example.com/cat.png');
    expect(img.getAttribute('alt')).toBe('A cat');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
  });
  it.each([
    ['http link', '[x](http://example.com)', 'x'],
    ['javascript link', '[x](javascript:alert(1))', 'x'],
    ['data link', '[x](data:text/html;base64,PHNjcmlwdD4=)', 'x'],
    ['mailto link', '[x](mailto:a@b.c)', 'x'],
    ['relative link', '[x](/admin)', 'x'],
  ])('turns a %s into plain text', async (_name, source, text) => {
    const root = await dom(source);
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toContain(text);
  });
  it.each([
    ['http image', '![tracker](http://example.com/p.gif)'],
    ['data image', '![tracker](data:image/gif;base64,R0lGODlhAQABAAAAACw=)'],
    ['relative image', '![tracker](/p.gif)'],
  ])('shows the alt text instead of a %s', async (_name, source) => {
    const root = await dom(source);
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('tracker');
  });
});

describe('renderMarkdown: hostile input stays inert', () => {
  it.each([
    '<script>window.hacked = 1</script>',
    '<img src=x onerror="window.hacked = 1">',
    '<a href="javascript:window.hacked=1">x</a>',
    '<iframe src="https://example.com"></iframe>',
    '<style>body{display:none}</style>',
    '<svg onload="window.hacked=1"></svg>',
    '[x](javascript:window.hacked=1)',
    '![x](https://example.com/a.png "title\\" onerror=\\"window.hacked=1")',
    '<div onclick="window.hacked=1">click</div>',
  ])('renders %j with no active element', async (source) => {
    const root = await dom(source);
    expect(root.querySelector('script, iframe, style, svg, object, embed, form, input, [onerror], [onload], [onclick]')).toBeNull();
    expect(root.querySelector('a[href^="javascript"]')).toBeNull();
    expect((window as unknown as { hacked?: number }).hacked).toBeUndefined();
  });
  it('shows raw html as text rather than dropping it', async () => {
    expect((await dom('<b>not bold</b>')).textContent).toContain('<b>not bold</b>');
  });
  it('survives unterminated tags, an empty string and a huge input', async () => {
    expect(await html('')).toBe('');
    await expect(html('<div <img src=x')).resolves.toBeTypeOf('string');
    await expect(html('a'.repeat(4000))).resolves.toContain('aaaa');
  });
});

describe('plainLine', () => {
  it.each([
    ['**great team**?', 'great team?'],
    ['A well-known _fact_', 'A well-known fact'],
    ['See [the docs](https://example.com/docs) now', 'See the docs now'],
    ['![A chart](https://example.com/c.png)', 'A chart'],
    ['## Heading here', 'Heading here'],
    ['> quoted *words*', 'quoted words'],
    ['- first item', 'first item'],
    ['* starred item', 'starred item'],
    ['12. numbered item', 'numbered item'],
    ['`code` and ~~gone~~', 'code and gone'],
    ['| a | b |\n| - | - |\n| 1 | 2 |', 'a b'],
    ['\n\n  \n---\nSecond   line   text', 'Second line text'],
    ['#hashtag stays', '#hashtag stays'],
    ['', ''],
  ])('%j -> %j', (source, expected) => {
    expect(plainLine(source)).toBe(expected);
  });
});

describe('sanitizeHtml and plainText', () => {
  it('strips attributes outside the allow-list and unwraps unknown elements', () => {
    const out = sanitizeHtml('<p class="x" style="color:red" onclick="1">hi <marquee>there</marquee></p>');
    expect(out).toBe('<p>hi there</p>');
  });
  it('makes tables and code blocks (which scroll sideways) reachable from the keyboard, and stays stable', () => {
    const out = sanitizeHtml('<table tabindex="-5"><tr><td>a</td></tr></table><pre><code>x</code></pre><p tabindex="0">p</p>');
    expect(out).toBe('<table tabindex="0"><tbody><tr><td>a</td></tr></tbody></table><pre tabindex="0"><code>x</code></pre><p>p</p>');
    expect(sanitizeHtml(out)).toBe(out);
  });
  it('keeps table alignment but nothing else in style', () => {
    expect(sanitizeHtml('<table><tr><td style="text-align:center">a</td><td style="position:fixed">b</td></tr></table>')).toContain('<td style="text-align:center">a</td><td>b</td>');
  });
  it.each([
    '<template><img src=x onerror="window.hacked=1"></template>',
    '<svg><a href="javascript:window.hacked=1"><text>x</text></a></svg>',
    '<math><mi><style><img src=x onerror="window.hacked=1"></style></mi></math>',
    '<noscript><p title="</noscript><img src=x onerror=window.hacked=1>"></noscript>',
    '<A HREF="JavaScript:window.hacked=1" ONCLICK="window.hacked=1">x</A>',
    '<a href=" javascript:window.hacked=1">x</a>',
    '<a href="java&#9;script:window.hacked=1">x</a>',
    '<img src="https://example.com/a.png" srcset="http://example.com/b.png 2x" style="position:fixed" onload="window.hacked=1">',
    '<a href="https://example.com" style="position:fixed" onmouseover="window.hacked=1">x</a>',
    '<form action="https://example.com"><button formaction="javascript:1">x</button></form>',
    '<base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example/">',
    '<table><tr><td style="background:url(https://evil.example/t.gif)">a</td></tr></table>',
  ])('sanitizeHtml leaves nothing active in %j', (source) => {
    const root = document.createElement('div');
    root.innerHTML = sanitizeHtml(source);
    expect(root.querySelector('template, svg, math, style, script, noscript, form, button, base, meta, [onerror], [onload], [onclick], [onmouseover], [srcset], [formaction]')).toBeNull();
    expect(root.querySelector('a[href^="javascript" i], a[href^=" "]')).toBeNull();
    expect(root.querySelector('[style*="url" i], [style*="fixed" i]')).toBeNull();
    expect(root.querySelector('img:not([src^="https://"])')).toBeNull();
    // Re-serialising must be stable, so a second parse cannot mutate into something active.
    expect(sanitizeHtml(root.innerHTML)).toBe(root.innerHTML);
    expect((window as unknown as { hacked?: number }).hacked).toBeUndefined();
  });
  it('escapes markup in the fallback text', () => {
    expect(plainText('<b>x</b> & y')).toBe('&lt;b&gt;x&lt;/b&gt; &amp; y');
  });
});
