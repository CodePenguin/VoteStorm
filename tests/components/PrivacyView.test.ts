// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { routes } from '@/router';
import PrivacyView from '@/views/PrivacyView.vue';

async function mountPrivacy() {
  const router = createRouter({ history: createMemoryHistory(), routes });
  router.push('/privacy');
  await router.isReady();
  const wrapper = mount(PrivacyView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('PrivacyView', () => {
  it('explains that a linked picture is loaded from a third-party website', async () => {
    const wrapper = await mountPrivacy();
    expect(squash(wrapper.text())).toContain(
      'A presenter can put a picture in a cloud by linking to it. The picture is loaded from the address the presenter chose, so your device contacts that website and it can see your internet address. VoteStorm does not send a referrer with that request.',
    );
  });

  it('says that words sent to a word cloud are shown to the room, and that a removed word is hidden, not deleted', async () => {
    const wrapper = await mountPrivacy();
    const text = squash(wrapper.text());
    expect(text).toContain('Words you send to a word cloud are shown to the whole room, without your name.');
    expect(text).toContain('If the presenter removes a word, it is hidden from the cloud, not deleted');
  });

  it('puts the picture note with the providers that handle your data, and keeps a Contact heading', async () => {
    const wrapper = await mountPrivacy();
    const headings = wrapper.findAll('h2').map((h) => h.text());
    expect(headings).toContain('Contact');
    expect(headings).not.toContain('Clouds');
    const html = wrapper.html();
    expect(html.indexOf('Who handles your data')).toBeLessThan(html.indexOf('put a picture in a cloud'));
    expect(html.indexOf('put a picture in a cloud')).toBeLessThan(html.indexOf('How long it is kept'));
  });
});
