// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import WordsInput from '@/components/WordsInput.vue';

const type = async (wrapper: ReturnType<typeof mount>, text: string, key?: string) => {
  const input = wrapper.find('input');
  await input.setValue(text);
  if (key) await input.trigger('keydown', { key });
};

describe('WordsInput', () => {
  it('turns Enter or a comma into a chip and counts words against the limit', async () => {
    const wrapper = mount(WordsInput, { props: { max: 3, initial: [], busy: false } });
    await type(wrapper, 'Team', 'Enter');
    await type(wrapper, 'work', ',');
    expect(wrapper.findAll('.word-chip').map((c) => c.text().replace('×', '').trim())).toEqual(['team', 'work']);
    expect(wrapper.text()).toContain('2 of 3 words');
  });
  it('adds a typed word with the Add button and ignores repeats and blanks', async () => {
    const wrapper = mount(WordsInput, { props: { max: 3, initial: [], busy: false } });
    await type(wrapper, 'a');
    await wrapper.find('button.add-word').trigger('click');
    await type(wrapper, 'A', 'Enter');
    await type(wrapper, '   ', 'Enter');
    expect(wrapper.findAll('.word-chip')).toHaveLength(1);
  });
  it('stops adding at the limit and says so', async () => {
    const wrapper = mount(WordsInput, { props: { max: 2, initial: ['a', 'b'], busy: false } });
    expect(wrapper.find('input').attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('2 of 2 words');
  });
  it('removes a chip', async () => {
    const wrapper = mount(WordsInput, { props: { max: 3, initial: ['a', 'b'], busy: false } });
    await wrapper.findAll('.word-chip button')[0].trigger('click');
    expect(wrapper.findAll('.word-chip').map((c) => c.text().replace('×', '').trim())).toEqual(['b']);
  });
  it('sends the words, adding what is still typed, and is disabled with none', async () => {
    const wrapper = mount(WordsInput, { props: { max: 3, initial: [], busy: false } });
    expect(wrapper.find('button.send-words').attributes('disabled')).toBeDefined();
    await type(wrapper, 'Hello');
    await wrapper.find('button.send-words').trigger('click');
    expect(wrapper.emitted('send')![0]).toEqual([['hello']]);
  });
  it('is disabled while sending', () => {
    const wrapper = mount(WordsInput, { props: { max: 3, initial: ['a'], busy: true } });
    expect(wrapper.find('button.send-words').attributes('disabled')).toBeDefined();
  });

  const chips = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('.word-chip').map((c) => c.text().replace('×', '').trim());

  it('splits pasted or typed comma-separated text into separate chips', async () => {
    const wrapper = mount(WordsInput, { props: { max: 5, initial: [], busy: false } });
    await type(wrapper, 'a, b, c');
    expect(chips(wrapper)).toEqual(['a', 'b', 'c']);
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('');
  });
  it('stops at the limit when more words are pasted than fit, and says so', async () => {
    const wrapper = mount(WordsInput, { props: { max: 2, initial: [], busy: false } });
    await type(wrapper, 'a, b, c, d');
    expect(chips(wrapper)).toEqual(['a', 'b']);
    expect(wrapper.text()).toContain('That is all your words');
  });
  it('does not let the input truncate a long pasted list before it is split', async () => {
    const wrapper = mount(WordsInput, { props: { max: 6, initial: [], busy: false } });
    const maxlength = wrapper.find('input').attributes('maxlength');
    expect(maxlength === undefined || Number(maxlength) >= 100).toBe(true);
    const pasted = 'alpha, beta, gamma, delta, epsilon, zeta, eta';
    expect(pasted.length).toBeGreaterThan(30);
    await type(wrapper, pasted);
    expect(chips(wrapper)).toEqual(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']);
    expect(wrapper.text()).toContain('That is all your words');
  });
  it('cuts a single word to the 30 characters the server accepts', async () => {
    const wrapper = mount(WordsInput, { props: { max: 3, initial: [], busy: false } });
    await type(wrapper, 'x'.repeat(45), 'Enter');
    expect(chips(wrapper)).toEqual(['x'.repeat(30)]);
  });
  it('says so, and still sends, when Send is pressed with a pending draft and the list is full', async () => {
    const wrapper = mount(WordsInput, { props: { max: 2, initial: ['a'], busy: false } });
    await type(wrapper, 'z');
    await wrapper.setProps({ initial: ['x', 'y'] });
    await wrapper.find('button.send-words').trigger('click');
    expect(wrapper.emitted('send')![0]).toEqual([['x', 'y']]);
    expect(wrapper.text()).toContain('That is all your words');
  });
  it('moves keyboard focus to Send when the limit is reached, so it is not lost to the disabled input', async () => {
    const wrapper = mount(WordsInput, { props: { max: 1, initial: [], busy: false }, attachTo: document.body });
    wrapper.find('input').element.focus();
    await type(wrapper, 'one', 'Enter');
    await nextTick();
    expect(document.activeElement).toBe(wrapper.find('button.send-words').element);
    wrapper.unmount();
  });
  it('reads "0 of 1 word" for a limit of one', () => {
    const wrapper = mount(WordsInput, { props: { max: 1, initial: [], busy: false } });
    expect(wrapper.text()).toContain('0 of 1 word');
    expect(wrapper.text()).not.toContain('0 of 1 words');
  });
  it('removes the last chip on Backspace only when the box is empty', async () => {
    const wrapper = mount(WordsInput, { props: { max: 3, initial: ['a', 'b'], busy: false } });
    await type(wrapper, 'x', 'Backspace');
    expect(chips(wrapper)).toEqual(['a', 'b']);
    await type(wrapper, '', 'Backspace');
    expect(chips(wrapper)).toEqual(['a']);
  });
  it('removes a chip with its labelled Remove button', async () => {
    const wrapper = mount(WordsInput, { props: { max: 3, initial: ['a', 'b'], busy: false } });
    await wrapper.find('button[aria-label="Remove a"]').trigger('click');
    expect(chips(wrapper)).toEqual(['b']);
  });
  it('disables the input and Add while busy', () => {
    const wrapper = mount(WordsInput, { props: { max: 3, initial: ['a'], busy: true } });
    expect(wrapper.find('input').attributes('disabled')).toBeDefined();
    expect(wrapper.find('button.add-word').attributes('disabled')).toBeDefined();
  });
  it('resets its chips when the initial words change', async () => {
    const wrapper = mount(WordsInput, { props: { max: 3, initial: ['a'], busy: false } });
    await type(wrapper, 'b', 'Enter');
    await wrapper.setProps({ initial: ['q', 'r'] });
    expect(chips(wrapper)).toEqual(['q', 'r']);
  });
  it('keeps non-Latin and emoji words', async () => {
    const wrapper = mount(WordsInput, { props: { max: 4, initial: [], busy: false } });
    await type(wrapper, '团队', 'Enter');
    await type(wrapper, '\u{1F389}', 'Enter');
    await type(wrapper, 'مرحبا', 'Enter');
    expect(chips(wrapper)).toEqual(['团队', '\u{1F389}', 'مرحبا']);
  });
});
