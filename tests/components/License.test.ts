// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { routes } from '@/router';
import type { LicenseSummary } from '@/shared/types';

const anonymous: LicenseSummary = { tier: 'anonymous', name: null, expiresAt: null, limits: { roomInactivityHours: 24 } };
const licensed: LicenseSummary = {
  tier: 'licensed', name: 'Acme Training', expiresAt: Date.UTC(2030, 5, 15, 12), limits: { roomInactivityHours: 168, maxQuestionsPerRoom: 40, maxAudiencePerRoom: 500 },
};

const apiMock = vi.fn();
vi.mock('@/api', () => ({
  api: (...a: unknown[]) => apiMock(...a),
  getDeviceId: () => 'd',
  ApiError: class ApiError extends Error {},
}));

import LicenseView from '@/views/LicenseView.vue';
import App from '@/App.vue';
import { takeLicenseFromHash, useLicense } from '@/composables/useLicense';
import { getStoredLicense } from '@/licenseStorage';

async function mountAt(url: string, component: object) {
  const router = createRouter({ history: createMemoryHistory(), routes });
  router.push(url);
  await router.isReady();
  const wrapper = mount(component, { global: { plugins: [router] } });
  await flushPromises();
  return { wrapper, router };
}

/** license-status answers based on the Authorization header the page sends (or the stored license). */
function statusServer(valid: Record<string, LicenseSummary>) {
  apiMock.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path !== 'license-status') throw new Error('unexpected ' + path);
    const header = (options?.headers as Record<string, string> | undefined)?.authorization;
    const token = header?.replace('Bearer ', '') ?? getStoredLicense();
    if (!token) return anonymous;
    if (valid[token]) return valid[token];
    throw new Error('Invalid license');
  });
}

describe('LicenseView', () => {
  beforeEach(() => {
    localStorage.clear();
    apiMock.mockReset();
  });

  it('shows the anonymous plan and its default limits when no license is loaded', async () => {
    statusServer({});
    const { wrapper } = await mountAt('/license', LicenseView);
    expect(wrapper.find('.plan-name').text()).toBe('Anonymous');
    expect(wrapper.text()).toContain('Rooms expire after');
    expect(wrapper.text()).toContain('24 hours of inactivity');
    expect(wrapper.text()).toContain('Unlimited');
    expect(wrapper.text()).toContain('Load a license');
    expect(wrapper.text()).not.toContain('Remove license');
  });

  it('activates a pasted license, keeps it, and shows its name, expiry and limits', async () => {
    statusServer({ 'good.jwt.token': licensed });
    const { wrapper } = await mountAt('/license', LicenseView);
    await wrapper.find('textarea').setValue('  good.jwt.token \n');
    await wrapper.find('.btn.primary').trigger('click');
    await flushPromises();
    expect(getStoredLicense()).toBe('good.jwt.token');
    expect(wrapper.find('.plan-name').text()).toBe('Acme Training');
    expect(wrapper.text()).toContain('Valid until');
    expect(wrapper.text()).toContain('7 days of inactivity');
    expect(wrapper.text()).toContain('40');
    expect(wrapper.text()).toContain('500');
    expect(wrapper.text()).toContain('Replace license');
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('');
  });

  it('shows the reason and keeps nothing when the license is rejected', async () => {
    statusServer({});
    const { wrapper } = await mountAt('/license', LicenseView);
    await wrapper.find('textarea').setValue('bad.jwt');
    await wrapper.find('.btn.primary').trigger('click');
    await flushPromises();
    expect(wrapper.find('.alert.error').text()).toContain('Invalid license');
    expect(getStoredLicense()).toBeNull();
  });

  it('does not offer to activate an empty license', async () => {
    statusServer({});
    const { wrapper } = await mountAt('/license', LicenseView);
    expect((wrapper.find('.btn.primary').element as HTMLButtonElement).disabled).toBe(true);
  });

  it('removes a loaded license and falls back to the anonymous plan', async () => {
    localStorage.setItem('votestorm_license', 'good.jwt.token');
    statusServer({ 'good.jwt.token': licensed });
    const { wrapper } = await mountAt('/license', LicenseView);
    expect(wrapper.find('.plan-name').text()).toBe('Acme Training');
    await wrapper.findAll('.btn').find((b) => b.text() === 'Remove license')!.trigger('click');
    await flushPromises();
    expect(getStoredLicense()).toBeNull();
    expect(wrapper.find('.plan-name').text()).toBe('Anonymous');
  });

  it('lets the user remove a saved license that no longer validates', async () => {
    localStorage.setItem('votestorm_license', 'expired.jwt');
    statusServer({});
    const { wrapper } = await mountAt('/license', LicenseView);
    expect(wrapper.find('.alert.error').text()).toContain('Invalid license');
    await wrapper.find('.alert .btn').trigger('click');
    await flushPromises();
    expect(getStoredLicense()).toBeNull();
    expect(wrapper.find('.alert.error').exists()).toBe(false);
    expect(wrapper.find('.plan-name').text()).toBe('Anonymous');
  });
});

describe('license links', () => {
  beforeEach(() => {
    localStorage.clear();
    apiMock.mockReset();
    window.location.hash = '';
  });
  afterEach(() => {
    window.location.hash = '';
  });

  it('reads a license from #licenseJwt= and removes it from the address bar', () => {
    window.location.hash = '#licenseJwt=abc.def.ghi';
    expect(takeLicenseFromHash()).toBe('abc.def.ghi');
    expect(window.location.hash).toBe('');
    expect(takeLicenseFromHash()).toBeNull();
  });

  it('activates the license from the link when the app opens, then shows the License page', async () => {
    statusServer({ 'link.jwt.token': licensed });
    window.location.hash = '#licenseJwt=link.jwt.token';
    const { router } = await mountAt('/', App);
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/license'));
    expect(getStoredLicense()).toBe('link.jwt.token');
    expect(useLicense().summary.value?.name).toBe('Acme Training');
    expect(window.location.hash).toBe('');
  });

  it('shows the License page with the reason when the linked license is bad', async () => {
    statusServer({});
    window.location.hash = '#licenseJwt=nope';
    const { router, wrapper } = await mountAt('/', App);
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/license'));
    await flushPromises();
    expect(getStoredLicense()).toBeNull();
    expect(useLicense().activateError.value).toContain('Invalid license');
    expect(wrapper.find('.alert.error').text()).toContain('Invalid license');
  });
});
