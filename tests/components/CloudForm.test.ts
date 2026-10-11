// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { reactive } from 'vue';
import { mount } from '@vue/test-utils';
import CloudForm from '@/components/presenter/CloudForm.vue';
import { blankForm } from '@/lib/presenter';
import type { CloudForm as Form, CloudPayload } from '@/shared/types';

// The page passes a deeply reactive form (a ref); reactive() does the same here so the form's own edits re-render it.
function setup(over: Partial<Form> = {}) {
  const wrapper = mount(CloudForm, { props: { modelValue: reactive({ ...blankForm(), body: 'Q', optionsText: 'A, B', ...over }), editing: false } });
  const save = async () => {
    await wrapper.find('.btn.primary').trigger('click');
    return wrapper.emitted('save')?.at(-1)?.[0] as CloudPayload | undefined;
  };
  return { wrapper, save };
}
const mode = (w: ReturnType<typeof mount>, value: string) => w.find(`.timer-field input[type=radio][value=${value}]`);

describe('CloudForm timer', () => {
  it('offers None, Manual and Auto-start for every kind, None by default with no timer sent', async () => {
    for (const kind of ['choice', 'rating', 'words', 'content'] as const) {
      const { wrapper, save } = setup({ kind });
      expect(wrapper.findAll('.timer-field input[type=radio]').map((r) => r.attributes('value'))).toEqual(['none', 'manual', 'auto']);
      expect((mode(wrapper, 'none').element as HTMLInputElement).checked).toBe(true);
      expect(wrapper.find('.timer-preset-select').exists()).toBe(false);
      const payload = await save();
      expect(payload).not.toHaveProperty('timerSeconds');
      expect(payload).not.toHaveProperty('timerAuto');
    }
  });

  it('sends a preset length, manual or auto', async () => {
    const { wrapper, save } = setup();
    await mode(wrapper, 'manual').setValue();
    const select = wrapper.find('.timer-preset-select');
    expect(select.findAll('option').map((o) => o.attributes('value'))).toEqual(['15', '30', '60', '120', '300', 'custom']);
    await select.setValue('120');
    expect(await save()).toMatchObject({ timerSeconds: 120, timerAuto: false });
    await mode(wrapper, 'auto').setValue();
    expect(await save()).toMatchObject({ timerSeconds: 120, timerAuto: true });
  });

  it('takes a custom number of seconds and refuses one out of range without sending', async () => {
    const { wrapper, save } = setup({ kind: 'content' });
    await mode(wrapper, 'auto').setValue();
    await wrapper.find('.timer-preset-select').setValue('custom');
    await wrapper.find('.timer-custom').setValue('45');
    expect(await save()).toEqual({ kind: 'content', body: 'Q', timerSeconds: 45, timerAuto: true });
    const sent = wrapper.emitted('save')!.length;
    await wrapper.find('.timer-custom').setValue('3601');
    await wrapper.find('.btn.primary').trigger('click');
    expect(wrapper.emitted('save')!.length).toBe(sent);
    expect(wrapper.find('.alert.error').exists()).toBe(true);
  });

  it('shows a timer problem as an alert in the Timer section and moves focus to the seconds field', async () => {
    const { wrapper } = setup({ kind: 'content' });
    document.body.appendChild(wrapper.element);
    await mode(wrapper, 'manual').setValue();
    await wrapper.find('.timer-preset-select').setValue('custom');
    await wrapper.find('.timer-custom').setValue('0');
    await wrapper.find('.btn.primary').trigger('click');
    await new Promise((r) => setTimeout(r));
    const alert = wrapper.find('.timer-field [role=alert]');
    expect(alert.exists()).toBe(true);
    expect(wrapper.find('.form-error').exists()).toBe(false);
    const input = wrapper.find('.timer-custom');
    expect(document.activeElement).toBe(input.element);
    expect(input.attributes('aria-invalid')).toBe('true');
    expect(input.attributes('aria-describedby')).toBe(alert.attributes('id'));
    await input.setValue('30');
    expect(wrapper.find('.timer-field [role=alert]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows any other problem as an alert at the top of the form', async () => {
    const { wrapper } = setup({ correctText: 'Z' });
    await wrapper.find('.btn.primary').trigger('click');
    expect(wrapper.find('.form-error').attributes('role')).toBe('alert');
    expect(wrapper.find('.timer-field [role=alert]').exists()).toBe(false);
  });

  it('opens an edited cloud with its timer, showing a length that is not a preset as custom', () => {
    const { wrapper } = setup({ timerMode: 'manual', timerSeconds: 45 });
    expect((mode(wrapper, 'manual').element as HTMLInputElement).checked).toBe(true);
    expect((wrapper.find('.timer-preset-select').element as HTMLSelectElement).value).toBe('custom');
    expect((wrapper.find('.timer-custom').element as HTMLInputElement).value).toBe('45');
  });
});
