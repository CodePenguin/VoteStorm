// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

// The renderer is a lazily imported chunk. After a deploy an old page can fail to fetch it; that failure must not be
// remembered, or markdown would stay unrendered until the page is reloaded.
let failNext = true;
vi.mock('markdown-it', async (importOriginal) => {
  if (failNext) {
    failNext = false;
    throw new Error('Failed to fetch dynamically imported module');
  }
  return importOriginal();
});

describe('renderMarkdown when the renderer chunk fails to load', () => {
  it('rejects once, then loads again on the next call', async () => {
    const { renderMarkdown } = await import('@/lib/markdown');
    await expect(renderMarkdown('**Hi**')).rejects.toThrow();
    await expect(renderMarkdown('**Hi**')).resolves.toContain('<strong>Hi</strong>');
  });
});
