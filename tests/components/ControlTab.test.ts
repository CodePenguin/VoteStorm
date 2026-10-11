// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const downloads: { name: string; text: string; type: string }[] = [];
vi.mock('@/lib/download', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/download')>()),
  downloadText: (name: string, text: string, type: string) => downloads.push({ name, text, type }),
}));

import ControlTab from '@/components/presenter/ControlTab.vue';
import { buildStormFile, readStormFileText, stormFileText, MAX_IMPORT_BYTES } from '@/lib/stormFile';
import { makeCloud, makeStore } from '../helpers/presentFixtures';
import type { AdminCloud } from '@/shared/types';

const mounted: ReturnType<typeof mount>[] = [];
beforeEach(() => {
  downloads.length = 0;
});
afterEach(() => mounted.splice(0).forEach((w) => w.unmount()));

const defaultClouds = () => [
  makeCloud({ id: 1, body: 'Pick a colour' }),
  makeCloud({ id: 2, kind: 'content', body: 'Hello', options: null, tally: { totalVotes: 0 } as never }),
];
function setup(clouds: AdminCloud[] = defaultClouds()) {
  const store = makeStore({ clouds });
  const wrapper = mount(ControlTab, { props: { store }, attachTo: document.body, global: { stubs: { RouterLink: true } } });
  mounted.push(wrapper);
  return { wrapper, store };
}

async function choose(wrapper: ReturnType<typeof mount>, content: string, name = 'storm.json') {
  const input = wrapper.find('input[type=file]');
  Object.defineProperty(input.element, 'files', { value: [new File([content], name, { type: 'application/json' })], configurable: true });
  await input.trigger('change');
  await vi.waitFor(() => expect(wrapper.find('[role=dialog], .file-error').exists()).toBe(true));
}
const goodFile = (n: number) =>
  stormFileText(buildStormFile({
    name: 'Imported',
    resultsBackground: null,
    clouds: Array.from({ length: n }, () => ({ kind: 'content', body: 'x', options: null, scale_min: null, scale_max: null, multi: 0, display: null, results_hidden: 0, correct: null, max_words: null })),
  }));

describe('ControlTab Storm file', () => {
  it('exports the Storm as a JSON file named after it, with its background and each cloud\'s timer', async () => {
    const { wrapper, store } = setup([
      makeCloud({ id: 1, body: 'Pick a colour', multi: 1, display: 'donut', correct: '[1]', results_hidden: 1, timer_seconds: 90, timer_auto: 1 }),
      makeCloud({ id: 2, kind: 'rating', body: 'Rate', options: null, scale_min: 1, scale_max: 5, display: null as never, timer_seconds: 45, timer_auto: 0 }),
    ]);
    store.resultsBackground.value = '#1e293b';
    await wrapper.find('.export-json').trigger('click');
    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toBe('all-hands.json');
    expect(downloads[0].type).toBe('application/json');
    expect(downloads[0].text).toBe(`{
  "votestorm": 1,
  "name": "All-hands",
  "resultsBackground": "#1e293b",
  "clouds": [
    {
      "kind": "choice",
      "body": "Pick a colour",
      "options": [
        "Red",
        "Blue"
      ],
      "scaleMin": null,
      "scaleMax": null,
      "multi": true,
      "display": "donut",
      "resultsHidden": true,
      "correct": [
        1
      ],
      "maxWords": null,
      "timerSeconds": 90,
      "timerAuto": true
    },
    {
      "kind": "rating",
      "body": "Rate",
      "options": null,
      "scaleMin": 1,
      "scaleMax": 5,
      "multi": false,
      "display": "bars",
      "resultsHidden": false,
      "correct": null,
      "maxWords": null,
      "timerSeconds": 45,
      "timerAuto": false
    }
  ]
}
`);
  });

  it('puts a hidden cloud\'s full results in the CSV: the presenter always has them', async () => {
    const { wrapper } = setup([makeCloud({ id: 1, body: 'Secret', results_hidden: 1, tally: { counts: [3, 1], totalVotes: 4 } as never })]);
    await wrapper.find('.export-csv').trigger('click');
    expect(downloads[0].text.replace(/^\uFEFF/, '').split('\r\n').slice(1, 3)).toEqual(['All-hands,1,choice,Secret,Red,3,75.0', 'All-hands,1,choice,Secret,Blue,1,25.0']);
  });

  it('downloads the results as CSV, named after the Storm, without removed words', async () => {
    const words = makeCloud({
      id: 3, kind: 'words', body: 'Mood', options: null, hidden_words: JSON.stringify(['rude']),
      tally: { words: [{ word: 'calm', count: 2 }, { word: 'rude', count: 1 }], totalVotes: 3 } as never,
    });
    const { wrapper } = setup([makeCloud({ id: 1, body: '# Pick a colour' }), words]);
    await wrapper.find('.export-csv').trigger('click');
    expect(downloads[0].name).toBe('all-hands-results.csv');
    expect(downloads[0].type).toBe('text/csv;charset=utf-8');
    const rows = downloads[0].text.replace(/^\uFEFF/, '').split('\r\n');
    expect(rows).toContain('All-hands,1,choice,Pick a colour,Red,3,75.0');
    expect(rows).toContain('All-hands,2,words,Mood,calm,2,66.7');
    expect(rows.some((r) => r.includes('rude'))).toBe(false);
  });

  it('puts the Storm code in the storm column and the file name when the Storm is unnamed', async () => {
    const { wrapper, store } = setup([makeCloud({ id: 1, body: 'Pick' })]);
    store.storm.value!.name = null;
    await wrapper.find('.export-csv').trigger('click');
    expect(downloads[0].name).toBe('storm-abcdefgh-results.csv');
    expect(downloads[0].text.replace(/^\uFEFF/, '').split('\r\n')[1]).toBe('ABCDEFGH,1,choice,Pick,Red,3,75.0');
  });

  it('shows what the file holds and what will be removed, with focus in the dialog', async () => {
    const { wrapper } = setup();
    await choose(wrapper, goodFile(3), 'q3.json');
    const dialog = wrapper.find('[role=dialog]');
    expect(dialog.attributes('aria-modal')).toBe('true');
    expect(dialog.find('.import-file').text()).toBe('q3.json');
    expect(dialog.find('.import-clouds').text()).toContain('3');
    expect(dialog.find('.import-current-clouds').text()).toContain('2');
    expect(dialog.find('.import-current-votes').text()).toContain('4');
    expect(dialog.element.contains(document.activeElement)).toBe(true);
    expect(dialog.find('.import-links-note').exists()).toBe(true);
  });

  it('replaces the Storm only after the presenter confirms', async () => {
    const { wrapper, store } = setup();
    await choose(wrapper, goodFile(1));
    expect(store.importStorm).not.toHaveBeenCalled();
    await wrapper.find('.import-confirm').trigger('click');
    await flushPromises();
    expect(store.importStorm).toHaveBeenCalledWith(JSON.parse(goodFile(1)));
    expect(wrapper.find('[role=dialog]').exists()).toBe(false);
  });

  it('keeps the dialog open with the server\'s reason when the import fails', async () => {
    const { wrapper, store } = setup();
    (store.importStorm as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: 'Cloud 1: refused' });
    await choose(wrapper, goodFile(1));
    await wrapper.find('.import-confirm').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role=dialog] [role=alert]').text()).toBe('Cloud 1: refused');
  });

  it('closes with Escape or Cancel, changing nothing, and gives focus back to Import', async () => {
    const { wrapper, store } = setup();
    const opener = wrapper.find('.import-json');
    (opener.element as HTMLElement).focus();
    await choose(wrapper, goodFile(1));
    await wrapper.find('[role=dialog]').trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(wrapper.find('[role=dialog]').exists()).toBe(false);
    expect(document.activeElement).toBe(opener.element);

    await choose(wrapper, goodFile(1));
    await wrapper.find('.import-cancel').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role=dialog]').exists()).toBe(false);
    expect(store.importStorm).not.toHaveBeenCalled();
  });

  it('gives focus to Import from file when nothing had focus as the dialog opened', async () => {
    const { wrapper } = setup();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    await choose(wrapper, goodFile(1));
    await wrapper.find('[role=dialog]').trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(document.activeElement).toBe(wrapper.find('.import-json').element);
  });

  it('explains each file it cannot use with that file\'s own reason, without a dialog or a request', async () => {
    const { wrapper, store } = setup();
    const files = ['not json', '{"votestorm":2,"clouds":[]}', JSON.stringify({ votestorm: 1, clouds: [{ kind: 'choice', body: 'x', options: ['one'] }] })];
    const shown: string[] = [];
    for (const content of files) {
      await choose(wrapper, content);
      const alert = wrapper.find('.file-error');
      expect(alert.attributes('role')).toBe('alert');
      expect(alert.text()).toBe(readStormFileText(content).error);
      expect(wrapper.find('[role=dialog]').exists()).toBe(false);
      shown.push(alert.text());
    }
    expect(new Set(shown).size).toBe(files.length);
    expect(store.importStorm).not.toHaveBeenCalled();
  });

  it('refuses a file over the size limit without reading it, and reads one exactly at the limit', async () => {
    const { wrapper, store } = setup();
    const read = vi.spyOn(FileReader.prototype, 'readAsText');
    await choose(wrapper, 'x'.repeat(MAX_IMPORT_BYTES + 1));
    const tooLarge = wrapper.find('.file-error').text();
    expect(tooLarge).not.toBe(readStormFileText('x').error);
    expect(read).not.toHaveBeenCalled();

    await choose(wrapper, 'x'.repeat(MAX_IMPORT_BYTES));
    expect(read).toHaveBeenCalledTimes(1);
    expect(wrapper.find('.file-error').text()).toBe(readStormFileText('x').error);
    expect(store.importStorm).not.toHaveBeenCalled();
    read.mockRestore();
  });

  it('sends one request when Replace is pressed twice, and Cancel does nothing meanwhile', async () => {
    const { wrapper, store } = setup();
    let finish!: (result: { ok: boolean }) => void;
    (store.importStorm as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise((r) => (finish = r)));
    await choose(wrapper, goodFile(1));
    expect(wrapper.find('.import-cancel').attributes('aria-disabled')).toBe('false');
    await wrapper.find('.import-confirm').trigger('click');
    expect(wrapper.find('.import-cancel').attributes('aria-disabled')).toBe('true');
    expect(wrapper.find('.import-confirm').attributes('aria-disabled')).toBe('true');
    await wrapper.find('.import-confirm').trigger('click');
    await wrapper.find('.import-cancel').trigger('click');
    expect(store.importStorm).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[role=dialog]').exists()).toBe(true);
    finish({ ok: true });
    await flushPromises();
    expect(wrapper.find('[role=dialog]').exists()).toBe(false);
  });

  it('shows a refusal only in the dialog, and leaves an earlier page error alone through Cancel', async () => {
    const { wrapper, store } = setup();
    store.error.value = 'an earlier problem';
    (store.importStorm as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: 'Cloud 1: refused' });
    await choose(wrapper, goodFile(1));
    await wrapper.find('.import-confirm').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role=dialog] [role=alert]').text()).toBe('Cloud 1: refused');
    expect(store.error.value).toBe('an earlier problem');
    await wrapper.find('.import-cancel').trigger('click');
    expect(wrapper.find('[role=dialog]').exists()).toBe(false);
    expect(store.error.value).toBe('an earlier problem');
  });

  it('closes the dialog without an error when the page moved to another Storm during the import', async () => {
    const { wrapper, store } = setup();
    (store.importStorm as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: null });
    await choose(wrapper, goodFile(1));
    await wrapper.find('.import-confirm').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role=dialog]').exists()).toBe(false);
    expect(wrapper.find('[role=alert]').exists()).toBe(false);
    expect(wrapper.emitted('imported')).toBeUndefined();
  });

  it('tells its parent when the import went through', async () => {
    const { wrapper } = setup();
    await choose(wrapper, goodFile(1));
    await wrapper.find('.import-confirm').trigger('click');
    await flushPromises();
    expect(wrapper.emitted('imported')).toHaveLength(1);
  });
});
