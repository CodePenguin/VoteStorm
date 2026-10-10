// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { flushPromises, mount } from '@vue/test-utils';
import PresentStage from '@/components/presenter/PresentStage.vue';
import { makeCloud, makeStore } from '../helpers/presentFixtures';
import type { AdminCloud } from '@/shared/types';
import type { VotingPhase } from '@/composables/useVotingClock';

function setup(cloud: AdminCloud | null, over: { next?: AdminCloud | null; phase?: VotingPhase; label?: string } = {}) {
  const store = makeStore({ clouds: cloud ? [cloud] : [], currentId: cloud?.id ?? null });
  const wrapper = mount(PresentStage, { props: { cloud, next: over.next ?? null, store, phase: over.phase ?? 'open', label: over.label ?? '' } });
  return { wrapper, store };
}
const words = (over: Partial<AdminCloud> = {}) =>
  makeCloud({ kind: 'words', body: 'One word', options: null, tally: { words: [{ word: 'calm', count: 5 }, { word: 'busy', count: 2 }], totalVotes: 7 } as never, hidden_words: JSON.stringify(['rude']), ...over } as never);
const content = (over: Partial<AdminCloud> = {}) => makeCloud({ kind: 'content', body: 'Just reading', options: null, tally: { totalVotes: 0 } as never, ...over } as never);

describe('PresentStage', () => {
  it('shows a question with its count and bars, and no word chips', () => {
    const { wrapper } = setup(makeCloud({ body: 'Cloud 1' }));
    expect(wrapper.text()).toContain('Cloud 1');
    expect(wrapper.text()).toContain('4 responses');
    expect(wrapper.text()).toContain('Red');
    expect(wrapper.text()).toContain('Blue');
    expect(wrapper.find('.word-moderation').exists()).toBe(false);
  });

  it('names the correct answer and says whether it is hidden', async () => {
    const c = makeCloud({ correct: JSON.stringify([1]), answer_shown: 0 } as never);
    const { wrapper } = setup(c);
    expect(wrapper.text()).toContain('Correct answer: Blue');
    expect(wrapper.text()).toContain('hidden from audience');
    await wrapper.setProps({ cloud: { ...c, answer_shown: 1 } });
    expect(wrapper.text()).toContain('Correct answer: Blue');
    expect(wrapper.text()).not.toContain('hidden from audience');
  });

  it('tells the presenter results are hidden but still shows them', () => {
    const { wrapper } = setup(makeCloud({ results_hidden: 1 }));
    expect(wrapper.text()).toContain('Results are hidden from the audience');
    expect(wrapper.text()).toContain('Red');
    expect(wrapper.find('.results-view .hidden-results').exists()).toBe(false);
  });

  it('shows word moderation before the preview, and removes and restores words', async () => {
    const c = words();
    const { wrapper, store } = setup(c);
    expect(wrapper.text()).toContain('7 people have sent words');
    await wrapper.find('[aria-label="Remove calm"]').trigger('click');
    expect(store.hideWord).toHaveBeenCalledWith(c, 'calm');
    expect(wrapper.find('[aria-label="Removed words"]').text()).toContain('rude');
    await wrapper.find('[aria-label="Restore rude"]').trigger('click');
    expect(store.showWord).toHaveBeenCalledWith(c, 'rude');
    const moderation = wrapper.find('.word-moderation').element;
    const preview = wrapper.find('ul.word-cloud').element;
    expect(preview).toBeTruthy();
    expect(moderation.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says "1 person has sent words" for a single sender', () => {
    const { wrapper } = setup(words({ tally: { words: [{ word: 'calm', count: 1 }], totalVotes: 1 } as never }));
    expect(wrapper.text()).toContain('1 person has sent words');
  });

  it('shows only the body for content', () => {
    const { wrapper } = setup(content());
    expect(wrapper.text()).toContain('Just reading');
    expect(wrapper.text()).not.toContain('responses');
    expect(wrapper.find('.results-view').exists()).toBe(false);
    expect(wrapper.find('.word-moderation').exists()).toBe(false);
  });

  it('shows a countdown only while running or closed, worded for the kind', () => {
    const q = makeCloud();
    expect(setup(q, { phase: 'running', label: '1:34' }).wrapper.find('[role="timer"]').text()).toBe('1:34');
    expect(setup(q, { phase: 'open' }).wrapper.find('[role="timer"]').exists()).toBe(false);
    expect(setup(content(), { phase: 'closed' }).wrapper.find('[role="timer"]').text()).toBe("Time's up");
    expect(setup(words(), { phase: 'closed' }).wrapper.find('[role="timer"]').text()).toBe('Submissions closed');
    expect(setup(q, { phase: 'closed' }).wrapper.find('[role="timer"]').text()).toBe('Voting closed');
  });

  it('shows the next cloud as Up next, or nothing', async () => {
    const next = makeCloud({ kind: 'words', body: '**One word** for today' });
    const { wrapper } = setup(makeCloud(), { next });
    expect(wrapper.find('.upnext').text()).toContain('Up next:');
    expect(wrapper.find('.upnext').text()).toContain('One word for today');
    expect(wrapper.find('.upnext').text()).toContain('Word cloud');
    await wrapper.setProps({ next: null });
    expect(wrapper.text()).not.toContain('Up next');
  });

  it('says no cloud is live when there is none', () => {
    const { wrapper } = setup(null);
    expect(wrapper.text()).toContain('No cloud is live');
    expect(wrapper.find('[role="timer"]').exists()).toBe(false);
    expect(wrapper.find('.results-view').exists()).toBe(false);
  });

  it('follows the cloud when it changes, including to none', async () => {
    const a = makeCloud({ body: 'Alpha question' });
    const b = words({ body: 'Beta words' });
    const { wrapper } = setup(a);
    expect(wrapper.text()).toContain('Alpha question');
    await wrapper.setProps({ cloud: b });
    expect(wrapper.text()).toContain('Beta words');
    expect(wrapper.text()).not.toContain('Alpha question');
    expect(wrapper.find('.word-moderation').exists()).toBe(true);
    await wrapper.setProps({ cloud: null });
    expect(wrapper.text()).toContain('No cloud is live');
    expect(wrapper.find('.word-moderation').exists()).toBe(false);
    await wrapper.setProps({ cloud: a });
    expect(wrapper.text()).toContain('Alpha question');
  });

  it('tells the presenter once that a word cloud\'s results are hidden, and still shows the words', () => {
    const { wrapper } = setup(words({ results_hidden: 1 }));
    expect(wrapper.findAll('.stage-hint').filter((p) => p.text().includes('Results are hidden from the audience'))).toHaveLength(1);
    expect(wrapper.find('ul.word-cloud').text()).toContain('calm');
    expect(setup(words()).wrapper.text()).not.toContain('Results are hidden');
  });

  it('shows the hidden-results hint only once for a question', () => {
    const { wrapper } = setup(makeCloud({ results_hidden: 1 }));
    expect(wrapper.findAll('.stage-hint')).toHaveLength(1);
  });

  it('has no correct-answer note without a correct answer, or for words and content', () => {
    expect(setup(makeCloud()).wrapper.find('.correct-note').exists()).toBe(false);
    expect(setup(makeCloud({ correct: JSON.stringify([]) } as never)).wrapper.find('.correct-note').exists()).toBe(false);
    expect(setup(words({ correct: JSON.stringify([0]) } as never)).wrapper.find('.correct-note').exists()).toBe(false);
    expect(setup(content({ correct: JSON.stringify([0]) } as never)).wrapper.find('.correct-note').exists()).toBe(false);
    expect(setup(content()).wrapper.text()).not.toContain('Correct answer');
  });

  it('shows Up next even when no cloud is live', () => {
    const { wrapper } = setup(null, { next: makeCloud({ body: 'The first one' }) });
    expect(wrapper.text()).toContain('No cloud is live');
    expect(wrapper.find('.upnext').text()).toContain('The first one');
  });

  it('puts a content cloud\'s countdown before its body, so the body keeps the full stage width', async () => {
    const { wrapper } = setup(content({ body: 'Long reading' }), { phase: 'running', label: '0:30' });
    await flushPromises();
    const head = wrapper.find('.stagehead.content');
    expect(head.exists()).toBe(true);
    const [first, second] = Array.from(head.element.children);
    expect(first.getAttribute('role')).toBe('timer');
    expect(second.classList.contains('stage-body')).toBe(true);
    const source = readFileSync('src/components/presenter/PresentStage.vue', 'utf8');
    expect(source).toMatch(/\.stagehead\.content \.countdown \{[^}]*float: right/);
    // A question keeps the title first and the countdown beside it.
    const q = setup(makeCloud({ body: 'Q' }), { phase: 'running', label: '0:30' }).wrapper.find('.stagehead');
    expect(q.classes()).not.toContain('content');
    expect(q.element.lastElementChild?.getAttribute('role')).toBe('timer');
  });

  it('uses level-2 section headings on the stage (under the page h1), with a small bounded preview that never collapses', () => {
    const { wrapper } = setup(words());
    expect(wrapper.find('h2.stage-section').text()).toBe('What the room sees (preview)');
    expect(wrapper.find('h2.word-removed-title').text()).toBe('Removed');
    expect(wrapper.find('h3').exists()).toBe(false);
    const source = readFileSync('src/components/presenter/PresentStage.vue', 'utf8');
    expect(source).toMatch(/\.word-preview \{[^}]*flex: none[^}]*max-height:[^}]*overflow: hidden/);
  });

  it('renders a markdown body through MarkdownContent and keeps long content inside a scrolling stage', async () => {
    const body = '## Heading\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nhttps://example.com/' + 'x'.repeat(300);
    const { wrapper } = setup(content({ body }));
    await flushPromises();
    expect(wrapper.find('.md').exists()).toBe(true);
    expect(wrapper.classes()).toContain('stage');
    const source = readFileSync('src/components/presenter/PresentStage.vue', 'utf8');
    expect(source).toMatch(/\.stage \{[^}]*min-width: 0[^}]*overflow: auto/);
    expect(source).toMatch(/\.stage-title \{[^}]*min-width: 0/);
  });
});
