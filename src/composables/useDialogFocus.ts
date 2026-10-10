import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** True when a control can actually take focus: not hidden, not inside something hidden or inert. */
function usable(el: HTMLElement): boolean {
  if (el.closest('[hidden], [inert]')) return false;
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

/** The controls inside `root` that Tab can reach, in document order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(usable);
}

/**
 * A modal dialog's focus: moves in when it opens, stays inside while it is open (Tab and Shift+Tab wrap), and returns to the
 * opener. When the opener is gone (it was inside something that closed as the dialog opened) or nothing had focus (a
 * keyboard shortcut opened it), focus goes to `fallback()` instead.
 */
export function useDialogFocus(dialog: Ref<HTMLElement | null>, open: Ref<boolean>, fallback?: () => HTMLElement | null) {
  let returnTo: HTMLElement | null = null;
  let listening = false;

  function onKeydown(e: KeyboardEvent) {
    const root = dialog.value;
    if (e.key !== 'Tab' || !root) return;
    const items = focusables(root);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const outside = !root.contains(document.activeElement);
    if (e.shiftKey && (document.activeElement === first || outside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || outside)) {
      e.preventDefault();
      first.focus();
    }
  }

  function listen(on: boolean) {
    if (on === listening) return;
    listening = on;
    if (on) document.addEventListener('keydown', onKeydown);
    else document.removeEventListener('keydown', onKeydown);
  }

  function giveBack() {
    const ok = returnTo && returnTo.isConnected && returnTo !== document.body;
    (ok ? returnTo : fallback?.() ?? returnTo)?.focus();
    returnTo = null;
  }

  watch(
    open,
    async (isOpen) => {
      if (isOpen) {
        returnTo = document.activeElement as HTMLElement | null;
        // Listen at once: Tab must be trapped from the moment the dialog opens, and a close during the wait removes it.
        listen(true);
        await nextTick();
        if (!open.value) return;
        const root = dialog.value;
        if (root && !root.contains(document.activeElement)) (focusables(root)[0] ?? root).focus();
      } else if (listening) {
        // Only a dialog that was open gives focus back (not the first, immediate run with the dialog closed).
        listen(false);
        giveBack();
      }
    },
    // Immediate: a dialog that is already open when its owner mounts still gets focus and the trap.
    { flush: 'post', immediate: true },
  );
  onBeforeUnmount(() => {
    // Unmounted while open (the whole view went away): the trap goes, and focus does not stay on a removed control.
    if (listening) {
      listen(false);
      giveBack();
    }
  });
}
