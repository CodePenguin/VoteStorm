// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { routes } from '@/router';

const apiMock = vi.fn();
vi.mock('@/api', () => ({
  api: (...a: unknown[]) => apiMock(...a),
  getDeviceId: () => 'd',
  ApiError: class ApiError extends Error {},
}));

import LandingView from '@/views/LandingView.vue';
import { rememberStorm } from '@/lib/recentStorms';
import App from '@/App.vue';

async function mountAt(url: string, component: object = LandingView) {
  const router = createRouter({ history: createMemoryHistory(), routes });
  router.push(url);
  await router.isReady();
  const wrapper = mount(component, { global: { plugins: [router] } });
  await flushPromises();
  return { wrapper, router };
}

describe('LandingView', () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it('explains the three steps', async () => {
    const { wrapper } = await mountAt('/');
    expect(wrapper.findAll('.step').map((s) => s.find('h2').text())).toEqual(['Create', 'Share', 'Watch live']);
  });

  it('links to Your Storms only once this device has some', async () => {
    localStorage.clear();
    expect((await mountAt('/')).wrapper.find('.your-storms').exists()).toBe(false);
    rememberStorm({ adminKey: 'K', stormCode: 'ABC234' });
    const { wrapper } = await mountAt('/');
    expect(wrapper.find('.your-storms a').attributes('href')).toBe('/storms');
    localStorage.clear();
  });

  it('creates a storm in one click and opens the presenter', async () => {
    apiMock.mockResolvedValue({ adminKey: 'SECRETKEY', stormCode: 'ABC234' });
    const { wrapper, router } = await mountAt('/');
    await wrapper.find('button').trigger('click');
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith('create-storm', { method: 'POST' });
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/presenter#key=SECRETKEY'), { timeout: 10000 });
  });

  it('points to the license page when storm creation is refused because of the license', async () => {
    apiMock.mockRejectedValue(Object.assign(new Error('This license has expired'), { code: 'license_invalid' }));
    const { wrapper } = await mountAt('/');
    await wrapper.find('button').trigger('click');
    await flushPromises();
    expect(wrapper.find('.alert.error').text()).toContain('This license has expired');
    expect(wrapper.find('.alert.error a').attributes('href')).toBe('/license');
  });

  it('shows the error and lets the user try again when creating fails', async () => {
    apiMock.mockRejectedValue(new Error('Database unavailable'));
    const { wrapper, router } = await mountAt('/');
    await wrapper.find('button').trigger('click');
    await flushPromises();
    expect(wrapper.find('.alert.error').text()).toBe('Database unavailable');
    expect((wrapper.find('button').element as HTMLButtonElement).disabled).toBe(false);
    expect(wrapper.find('button').text()).toBe('Create a Storm');
    expect(router.currentRoute.value.fullPath).toBe('/');
  });
});

describe('App shell', () => {
  it('shows the Code Penguin footer on ordinary pages', async () => {
    const { wrapper } = await mountAt('/', App);
    expect(wrapper.find('.app-footer a').attributes('href')).toBe('https://codepenguin.com');
    expect(wrapper.findAll('.app-footer a').map((a) => a.attributes('href'))).toEqual(['https://codepenguin.com', '/license', '/privacy']);
  });

  it('serves the privacy page', async () => {
    const { wrapper } = await mountAt('/privacy', App);
    expect(wrapper.find('h1').text()).toBe('Privacy');
    expect(wrapper.text()).toContain('sets no cookies');
  });

  it('leaves the footer to the projector results screen', async () => {
    apiMock.mockRejectedValue(new Error('x'));
    const { wrapper } = await mountAt('/results#key=KEY', App);
    expect(wrapper.find('.app-footer').exists()).toBe(false);
    expect(wrapper.find('.results-page .footer .attribution a').attributes('href')).toBe('https://codepenguin.com');
  });

  it('shows a way home for unknown pages', async () => {
    const { wrapper } = await mountAt('/no/such/page', App);
    expect(wrapper.text()).toContain('Page not found');
    expect(wrapper.find('a[href="/"]').exists()).toBe(true);
  });
});
