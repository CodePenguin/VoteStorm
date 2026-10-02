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

  async function subscribeRoom(roomCode, handlers) {
    const ably = new Ably.Realtime({
      authCallback: async (_, cb) => {
        try {
          const tokenRequest = await api(`ably-token?roomCode=${encodeURIComponent(roomCode)}`);
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
    return ably;
  }

  return { getDeviceId, api, subscribeRoom };
})();
