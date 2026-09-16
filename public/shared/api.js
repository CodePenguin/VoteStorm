window.LivePoll = (function () {
  function getDeviceId() {
    let id = localStorage.getItem('livepoll_device_id');
    if (!id) {
      id = crypto.randomUUID();
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
