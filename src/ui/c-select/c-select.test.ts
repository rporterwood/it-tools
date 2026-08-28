// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import CSelect from './c-select.vue';

// Labels shaped like the file converter's target list ("<format> (<converter>)"), which is the
// biggest searchable list in the app and the one that made this path matter.
const options = ['mp4 (ffmpeg)', 'webm (ffmpeg)', 'png (imagemagick)'];

async function mountOpenAndSearch(query: string) {
  const wrapper = mount(CSelect, { props: { options, searchable: true } });
  await wrapper.get('.c-select-input').trigger('click');
  await wrapper.get('.search-input').setValue(query);
  return wrapper;
}

describe('CSelect', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('[searchable] narrows the dropdown to the matching options', async () => {
    const wrapper = await mountOpenAndSearch('webm');

    const labels = wrapper.findAll('.c-select-dropdown-option').map(option => option.text());
    expect(labels).toEqual(['webm (ffmpeg)']);
  });

  it('[searchable] arrow keys cannot walk focus past the end of the filtered list', async () => {
    // Regression guard: focus was clamped against the *unfiltered* option count, so after a
    // search narrowed 3 options down to 1, a second ArrowDown left focusIndex pointing at an
    // option that no longer existed and Enter then read `.value` off undefined.
    const wrapper = await mountOpenAndSearch('webm');
    const trigger = wrapper.get('.c-select-input');

    await trigger.trigger('keydown', { key: 'ArrowDown' });
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    await trigger.trigger('keydown', { key: 'Enter' });

    expect(wrapper.emitted('update:value')).toEqual([['webm (ffmpeg)']]);
  });
});
