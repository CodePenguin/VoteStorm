/** Copies text; tries the synchronous legacy path first (works inside an iOS tap), then the async API. */
export async function copyText(text: string): Promise<boolean> {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px;';
  document.body.appendChild(ta);
  let ok = false;
  try {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(ta);
    sel?.removeAllRanges();
    sel?.addRange(range);
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(ta);
  }
  if (ok) return true;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}
