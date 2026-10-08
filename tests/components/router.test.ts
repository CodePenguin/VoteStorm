import { describe, it, expect } from 'vitest';
import { createRouter, createMemoryHistory } from 'vue-router';
import { routes } from '@/router';

const resolve = (path: string) => createRouter({ history: createMemoryHistory(), routes }).resolve(path);

describe('router', () => {
  it('maps the app URLs to named routes with their params', () => {
    expect(resolve('/').name).toBe('landing');
    expect(resolve('/presenter').name).toBe('presenter');
    expect(resolve('/vote/XYZ234')).toMatchObject({ name: 'vote', params: { stormCode: 'XYZ234' } });
    expect(resolve('/results').name).toBe('results');
    expect(resolve('/storms').name).toBe('storms');
    expect(resolve('/presenter/ABCDEFGH')).toMatchObject({ name: 'presenter', params: { stormCode: 'ABCDEFGH' } }); // the secret lives after the #
    expect(resolve('/presenter').params.stormCode).toBeFalsy();
    expect(resolve('/license').name).toBe('license');
    expect(resolve('/privacy').name).toBe('privacy');
    expect(resolve('/nope/nothing').name).toBe('not-found');
  });

  it('lets the projector results screen draw its own footer', () => {
    expect(resolve('/results').meta.ownFooter).toBe(true);
    expect(resolve('/vote/k').meta.ownFooter).toBeUndefined();
  });
});
