// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { routes } from '@/router';
import { loadRecent, rememberStorm } from '@/lib/recentStorms';

const { FakeApiError } = vi.hoisted(() => ({
  FakeApiError: class FakeApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('@/api', () => ({ getDeviceId: () => 'd', ApiError: FakeApiError }));
const signedMock = vi.fn();
vi.mock('@/lib/adminRequest', () => ({ signedApi: (...a: unknown[]) => signedMock(...a) }));

import StormsView from '@/views/StormsView.vue';

const detail = (over: Record<string, unknown> = {}, clouds = 2) => ({
  storm: { storm_code: 'AAAA1111', status: 'active', current_cloud_id: null, name: null, created_at: Date.now() - 3600000, last_activity_at: Date.now() - 600000, inactivity_hours: 24, ...over },
  clouds: Array.from({ length: clouds }, (_, i) => ({ id: i + 1 })),
});

async function mountStorms() {
  const router = createRouter({ history: createMemoryHistory(), routes });
  router.push('/storms');
  await router.isReady();
  const wrapper = mount(StormsView, { global: { plugins: [router] } });
  await flushPromises();
  return { wrapper, router };
}

describe('StormsView', () => {
  beforeEach(() => {
    localStorage.clear();
    signedMock.mockReset();
  });

  it('says so when this device has no Storms yet', async () => {
    const { wrapper } = await mountStorms();
    expect(wrapper.text()).toContain('No Storms on this device yet');
    expect(signedMock).not.toHaveBeenCalled();
  });

  it('lists the remembered Storms with their current status, checking each with a signed request', async () => {
    rememberStorm({ stormCode: 'AAAA1111', secret: 'SEC-A', name: 'Old name' }, 2000);
    rememberStorm({ stormCode: 'BBBB2222', secret: 'SEC-B' }, 1000);
    signedMock.mockImplementation(async (session: { stormCode: string; secret: string }) =>
      session.secret === 'SEC-A' ? detail({ name: 'Town hall' }, 3) : detail({ storm_code: 'BBBB2222', status: 'closed' }, 1));
    const { wrapper } = await mountStorms();

    expect(signedMock.mock.calls.map((c) => [c[0], c[1], c.length]).sort()).toEqual([
      [{ stormCode: 'AAAA1111', secret: 'SEC-A' }, 'admin-storm', 2],
      [{ stormCode: 'BBBB2222', secret: 'SEC-B' }, 'admin-storm', 2],
    ]);
    const rows = wrapper.findAll('.storm-row');
    expect(rows.map((r) => r.find('.storm-title').text())).toEqual(['Town hall', 'Storm BBBB 2222']);
    expect(rows[0].find('.storm-code').text()).toBe('Storm code AAAA 1111');
    expect(rows[0].text()).toContain('3 clouds');
    expect(rows[0].text()).toContain('expires in');
    expect(rows[1].find('.badge').text()).toBe('closed');
    expect(rows[1].text()).toContain('1 cloud');
    expect(rows[1].find('.btn:not(.primary)').attributes('aria-label')).toBe('Forget Storm BBBB 2222');
    expect(loadRecent().find((e) => e.stormCode === 'AAAA1111')!.name).toBe('Town hall');
    expect(loadRecent().map((e) => e.stormCode)).toEqual(['AAAA1111', 'BBBB2222']);
  });

  it('opens a Storm in the presenter with its code in the path and its secret after the #', async () => {
    rememberStorm({ stormCode: 'AAAA1111', secret: 'SEC-A' });
    signedMock.mockResolvedValue(detail());
    const { wrapper, router } = await mountStorms();
    await wrapper.find('.storm-actions .btn.primary').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/presenter/AAAA1111#k=SEC-A'), { timeout: 10000 });
  });

  it('drops Storms that have expired or been deleted, but keeps ones it just could not check', async () => {
    rememberStorm({ stormCode: 'GONE0001', secret: 'GONE' }, 4000);
    rememberStorm({ stormCode: 'MISS0001', secret: 'MISS' }, 3000);
    rememberStorm({ stormCode: 'FLKY0001', secret: 'FLAKY' }, 2000);
    rememberStorm({ stormCode: 'FINE0001', secret: 'FINE' }, 1000);
    signedMock.mockImplementation(async (session: { secret: string }) => {
      if (session.secret === 'GONE') throw new FakeApiError('Invalid admin key', 401);
      if (session.secret === 'MISS') throw new FakeApiError('Not found', 404);
      if (session.secret === 'FLAKY') throw new FakeApiError('Server error', 500);
      return detail({ storm_code: 'FINE0001' });
    });
    const { wrapper } = await mountStorms();
    // admin-storm no longer answers 404 for a missing Storm, so a 404 is just a failed check: kept, not forgotten.
    expect(wrapper.findAll('.storm-title').map((t) => t.text())).toEqual(['Storm MISS 0001', 'Storm FLKY 0001', 'Storm FINE 0001']);
    expect(wrapper.text()).toContain('couldn’t check right now');
    expect(loadRecent().map((e) => e.stormCode)).toEqual(['MISS0001', 'FLKY0001', 'FINE0001']);
  });

  it('keeps a Storm whose check failed on clock skew, since the signature was valid and the secret is the only copy', async () => {
    rememberStorm({ stormCode: 'SKEW0001', secret: 'SKEW' });
    signedMock.mockRejectedValue(Object.assign(new FakeApiError('This device’s clock is out of step with the server', 401), { code: 'clock_skew' }));
    const { wrapper } = await mountStorms();
    expect(wrapper.findAll('.storm-title').map((t) => t.text())).toEqual(['Storm SKEW 0001']);
    expect(wrapper.text()).toContain('couldn’t check right now');
    expect(loadRecent().map((e) => [e.stormCode, e.secret])).toEqual([['SKEW0001', 'SKEW']]);
  });

  it('forgets a Storm from the list without deleting it', async () => {
    rememberStorm({ stormCode: 'AAAA1111', secret: 'SEC-A' });
    signedMock.mockResolvedValue(detail());
    const { wrapper } = await mountStorms();
    await wrapper.findAll('.storm-actions .btn')[1].trigger('click');
    expect(wrapper.find('.storm-row').exists()).toBe(false);
    expect(loadRecent()).toEqual([]);
    // Only the one status check was made, with no options (so no DELETE), and nothing was sent after Forget.
    expect(signedMock).toHaveBeenCalledTimes(1);
    expect(signedMock.mock.calls.every((c) => c[1] === 'admin-storm' && c.length === 2)).toBe(true);
  });
});
