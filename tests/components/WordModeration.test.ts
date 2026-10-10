// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import WordModeration from '@/components/presenter/WordModeration.vue';
import type { AdminCloud } from '@/shared/types';

const cloud = (over: Partial<AdminCloud> = {}) =>
  ({ id: 5, kind: 'words', body: 'Words', hidden_words: null, tally: { words: [{ word: 'calm', count: 3 }, { word: 'rude', count: 1 }], totalVotes: 4 }, ...over }) as unknown as AdminCloud;

function setup(c: AdminCloud) {
  const store = { hideWord: vi.fn(), showWord: vi.fn() };
  const wrapper = mount(WordModeration, { props: { cloud: c, store: store as never } });
  return { wrapper, store };
}

describe('WordModeration', () => {
  it('lists the words with a remove button each, and removes one', async () => {
    const c = cloud();
    const { wrapper, store } = setup(c);
    expect(wrapper.findAll('[aria-label="Words sent"] li').map((li) => li.text())).toEqual(expect.arrayContaining([expect.stringContaining('calm'), expect.stringContaining('rude')]));
    await wrapper.find('[aria-label="Remove rude"]').trigger('click');
    expect(store.hideWord).toHaveBeenCalledWith(c, 'rude');
  });

  it('lists removed words under "Removed" and restores one', async () => {
    const c = cloud({ hidden_words: JSON.stringify(['rude']) });
    const { wrapper, store } = setup(c);
    expect(wrapper.text()).toContain('Removed');
    await wrapper.find('[aria-label="Restore rude"]').trigger('click');
    expect(store.showWord).toHaveBeenCalledWith(c, 'rude');
  });

  it('says so when there are no words yet, and hides the Removed heading when nothing is removed', () => {
    const { wrapper } = setup(cloud({ tally: { words: [], totalVotes: 0 } as never }));
    expect(wrapper.text()).toContain('No words yet');
    expect(wrapper.text()).not.toContain('Removed');
  });
});
