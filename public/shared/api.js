window.LivePoll = (function () {
  function generateId() {
    // crypto.randomUUID() only exists in a secure context (HTTPS, or
    // http://localhost) — fall back to a non-cryptographic v4-shaped id so
    // this still works over plain HTTP (e.g. testing via a LAN IP). This id
    // only needs to be unique per browser, not unguessable.
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function getDeviceId() {
    let id = localStorage.getItem('livepoll_device_id');
    if (!id) {
      id = generateId();
      localStorage.setItem('livepoll_device_id', id);
    }
    return id;
  }

  async function api(path, options = {}) {
    const res = await fetch(`/.netlify/functions/${path}`, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed: ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // opts.clientId: join the room's presence set (voters pass their device id).
  // opts.onPresence(count): called with the number of distinct connected voters.
  async function subscribeRoom(roomCode, handlers, opts = {}) {
    const ably = new Ably.Realtime({
      ...(opts.clientId ? { clientId: opts.clientId } : {}),
      authCallback: async (_, cb) => {
        try {
          const clientPart = opts.clientId ? `&clientId=${encodeURIComponent(opts.clientId)}` : '';
          const tokenRequest = await api(`ably-token?roomCode=${encodeURIComponent(roomCode)}${clientPart}`);
          cb(null, tokenRequest);
        } catch (err) {
          cb(err, null);
        }
      },
    });
    const channel = ably.channels.get(`room:${roomCode}`);
    for (const [eventName, handler] of Object.entries(handlers)) {
      channel.subscribe(eventName, (msg) => handler(msg.data));
    }
    if (opts.clientId) {
      channel.presence.enter().catch(() => {});
    }
    if (opts.onPresence) {
      const refresh = async () => {
        try {
          const members = await channel.presence.get();
          opts.onPresence(new Set(members.map((m) => m.clientId)).size);
        } catch (err) {
          /* presence is best-effort */
        }
      };
      channel.presence.subscribe(refresh).then(refresh).catch(() => {});
    }
    return ably;
  }

  // Alpine state + methods for the swipeable all-questions view shown once a room is closed.
  // Spread into a page's component: { ...LivePoll.carouselMixin(), roomCode, ... }
  function carouselMixin() {
    return {
      slides: null,
      slide: 0,

      async loadClosedResults() {
        const data = await api(`get-room-results?roomCode=${encodeURIComponent(this.roomCode)}`);
        this.slides = data.questions;
        this.slide = 0;
      },

      goTo(i) {
        const track = this.$refs.track;
        if (!track || !this.slides || !this.slides.length) return;
        const next = Math.max(0, Math.min(this.slides.length - 1, i));
        this.slide = next;
        track.scrollTo({ left: next * track.clientWidth, behavior: 'smooth' });
      },

      onScroll() {
        const track = this.$refs.track;
        if (!track || !track.clientWidth) return;
        this.slide = Math.round(track.scrollLeft / track.clientWidth);
      },

      donutColor(i) {
        return ['#2563eb', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'][i % 8];
      },

      slideSeg(q, i) {
        const counts = q.options.map((_, n) => q.tally.counts[n] || 0);
        const sum = counts.reduce((x, y) => x + y, 0);
        let acc = 0;
        for (let n = 0; n < i; n++) acc += sum ? (counts[n] / sum) * 100 : 0;
        return { dash: sum ? ((counts[i] || 0) / sum) * 100 : 0, offset: -acc };
      },

      slideValues(q) {
        const n = q.scaleMax - q.scaleMin + 1;
        return Array.from({ length: n }, (_, k) => q.scaleMin + k);
      },

      slideCount(q, key) {
        return q.tally.counts[key] || 0;
      },

      slidePct(q, key) {
        const total = q.tally.totalVotes || 0;
        return total ? Math.round((this.slideCount(q, key) / total) * 100) : 0;
      },

      slideLeader(q, key) {
        const count = this.slideCount(q, key);
        if (!count) return false;
        return count === Math.max(...Object.values(q.tally.counts).map((c) => c || 0));
      },

      fmtAvg(avg) {
        return avg === null || avg === undefined ? '–' : Number(avg).toFixed(1);
      },
    };
  }

  async function copyText(text) {
    // execCommand first: it is synchronous inside the click gesture (works on iOS) and cannot hang on a permission prompt.
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
      sel.removeAllRanges();
      sel.addRange(range);
      ta.setSelectionRange(0, text.length);
      ok = document.execCommand('copy');
    } catch (err) {
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
    } catch (err) { /* ignore */ }
    return false;
  }

  return { getDeviceId, api, subscribeRoom, carouselMixin, copyText };
})();
