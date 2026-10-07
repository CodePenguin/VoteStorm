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

const apiMock = vi.fn();
vi.mock('@/api', () => ({ api: (...a: unknown[]) => apiMock(...a), getDeviceId: () => 'd', ApiError: FakeApiError }));

import StormsView from '@/views/StormsView.vue';

const detail = (over: Record<string, unknown> = {}, questions = 2) => ({
  storm: { storm_code: 'AAA111', status: 'active', current_question_id: null, name: null, created_at: Date.now() - 3600000, last_activity_at: Date.now() - 600000, inactivity_hours: 24, ...over },
  questions: Array.from({ length: questions }, (_, i) => ({ id: i + 1 })),
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
    apiMock.mockReset();
  });

  it('says so when this device has no Storms yet', async () => {
    const { wrapper } = await mountStorms();
    expect(wrapper.text()).toContain('No Storms on this device yet');
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('lists the remembered Storms with their current status, checking each with its key in a header', async () => {
    rememberStorm({ adminKey: 'KEY-A', stormCode: 'AAA111', name: 'Old name' }, 2000);
    rememberStorm({ adminKey: 'KEY-B', stormCode: 'BBB222' }, 1000);
    apiMock.mockImplementation(async (_path: string, options: { headers: Record<string, string> }) =>
      options.headers['x-admin-key'] === 'KEY-A' ? detail({ name: 'Town hall' }, 3) : detail({ storm_code: 'BBB222', status: 'closed' }, 1));
    const { wrapper } = await mountStorms();

    expect(apiMock.mock.calls.map((c) => [c[0], c[1].headers['x-admin-key']]).sort()).toEqual([['admin-storm', 'KEY-A'], ['admin-storm', 'KEY-B']]);
    const rows = wrapper.findAll('.storm-row');
    expect(rows.map((r) => r.find('.storm-title').text())).toEqual(['Town hall', 'Storm BBB222']);
    expect(rows[0].text()).toContain('3 questions');
    expect(rows[0].text()).toContain('expires in');
    expect(rows[1].find('.badge').text()).toBe('closed');
    expect(rows[1].text()).toContain('1 question');
    expect(loadRecent().find((e) => e.adminKey === 'KEY-A')!.name).toBe('Town hall');
  });

  it('opens a Storm in the presenter with its key after the #', async () => {
    rememberStorm({ adminKey: 'KEY-A', stormCode: 'AAA111' });
    apiMock.mockResolvedValue(detail());
    const { wrapper, router } = await mountStorms();
    await wrapper.find('.storm-actions .btn.primary').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/presenter#key=KEY-A'), { timeout: 10000 });
  });

  it('drops Storms that have expired or been deleted, but keeps ones it just could not check', async () => {
    rememberStorm({ adminKey: 'GONE', stormCode: 'GONE01' }, 3000);
    rememberStorm({ adminKey: 'FLAKY', stormCode: 'FLK001' }, 2000);
    rememberStorm({ adminKey: 'FINE', stormCode: 'FIN001' }, 1000);
    apiMock.mockImplementation(async (_p: string, o: { headers: Record<string, string> }) => {
      const key = o.headers['x-admin-key'];
      if (key === 'GONE') throw new FakeApiError('Invalid admin key', 401);
      if (key === 'FLAKY') throw new FakeApiError('Server error', 500);
      return detail({ storm_code: 'FIN001' });
    });
    const { wrapper } = await mountStorms();
    expect(wrapper.findAll('.storm-title').map((t) => t.text())).toEqual(['Storm FLK001', 'Storm FIN001']);
    expect(wrapper.text()).toContain('couldn’t check right now');
    expect(loadRecent().map((e) => e.adminKey)).toEqual(['FLAKY', 'FINE']);
  });

  it('forgets a Storm from the list without deleting it', async () => {
    rememberStorm({ adminKey: 'KEY-A', stormCode: 'AAA111' });
    apiMock.mockResolvedValue(detail());
    const { wrapper } = await mountStorms();
    await wrapper.findAll('.storm-actions .btn')[1].trigger('click');
    expect(wrapper.find('.storm-row').exists()).toBe(false);
    expect(loadRecent()).toEqual([]);
    expect(apiMock.mock.calls.some((c) => c[1]?.method === 'DELETE')).toBe(false);
  });
});
