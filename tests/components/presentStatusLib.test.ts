import { describe, it, expect } from 'vitest';
import { kindName, presentStatus } from '@/lib/presenter';
import type { AdminCloud } from '@/shared/types';

const cloud = (over: Partial<AdminCloud> = {}) =>
  ({ id: 1, kind: 'choice', body: 'Q', results_hidden: 0, answer_shown: 0, correct: null, max_words: null, ...over }) as AdminCloud;
const texts = (lines: ReturnType<typeof presentStatus>) => lines.map((l) => l.text);

describe('presentStatus', () => {
  it('says nothing is live, and still shows the join state', () => {
    expect(texts(presentStatus({ cloud: null, phase: 'open', label: '', showConnect: false }))).toEqual(['No cloud is live', 'Join screen off']);
    expect(texts(presentStatus({ cloud: null, phase: 'open', label: '', showConnect: true }))).toEqual(['No cloud is live', 'Join screen showing']);
  });
  it('shows an open question as voting open, highlighted', () => {
    const lines = presentStatus({ cloud: cloud(), phase: 'open', label: '', showConnect: false });
    expect(lines[0]).toMatchObject({ key: 'state', text: 'Voting open', tone: 'on' });
  });
  it('uses submissions wording for a word cloud and no-timer for content (neutral)', () => {
    expect(presentStatus({ cloud: cloud({ kind: 'words' }), phase: 'open', label: '', showConnect: false })[0].text).toBe('Submissions open');
    expect(presentStatus({ cloud: cloud({ kind: 'content' }), phase: 'open', label: '', showConnect: false })[0]).toMatchObject({ text: 'No timer', tone: 'neutral' });
  });
  it('shows the countdown while running and the closed wording when ended, per kind', () => {
    expect(presentStatus({ cloud: cloud(), phase: 'running', label: '1:34', showConnect: false })[0]).toMatchObject({ text: '1:34 left', tone: 'on' });
    expect(presentStatus({ cloud: cloud(), phase: 'closed', label: '', showConnect: false })[0]).toMatchObject({ text: 'Voting closed', tone: 'warn' });
    expect(presentStatus({ cloud: cloud({ kind: 'words' }), phase: 'closed', label: '', showConnect: false })[0].text).toBe('Submissions closed');
    expect(presentStatus({ cloud: cloud({ kind: 'content' }), phase: 'closed', label: '', showConnect: false })[0].text).toBe("Time's up");
  });
  it('flags hidden results for questions and word clouds but never for content', () => {
    expect(texts(presentStatus({ cloud: cloud({ results_hidden: 1 }), phase: 'open', label: '', showConnect: false }))).toContain('Results hidden');
    expect(texts(presentStatus({ cloud: cloud({ kind: 'words', results_hidden: 1 }), phase: 'open', label: '', showConnect: false }))).toContain('Results hidden');
    expect(texts(presentStatus({ cloud: cloud({ kind: 'content', results_hidden: 1 }), phase: 'open', label: '', showConnect: false }))).not.toContain('Results hidden');
  });
  it('highlights the join screen when it is showing', () => {
    const join = presentStatus({ cloud: cloud(), phase: 'open', label: '', showConnect: true }).find((l) => l.key === 'join');
    expect(join).toMatchObject({ text: 'Join screen showing', tone: 'on' });
    expect(presentStatus({ cloud: cloud(), phase: 'open', label: '', showConnect: false }).find((l) => l.key === 'join')).toMatchObject({ text: 'Join screen off', tone: 'neutral' });
  });
});

describe('kindName', () => {
  it('names each kind for the Up next line', () => {
    expect(kindName(cloud({ kind: 'content' }))).toBe('Content');
    expect(kindName(cloud({ kind: 'words' }))).toBe('Word cloud');
    expect(kindName(cloud({ kind: 'choice' }))).toBe('Question');
    expect(kindName(cloud({ kind: 'rating' }))).toBe('Rating');
  });
});
