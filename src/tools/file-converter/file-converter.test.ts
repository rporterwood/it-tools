// @vitest-environment jsdom
import type { VueWrapper } from '@vue/test-utils';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FileConverter from './file-converter.vue';
import type { ConvertResult, ConvertState } from './useConvertX';
import { useConvertX } from './useConvertX';
import { downloadFile } from './convertx.service';
import CFileUpload from '@/ui/c-file-upload/c-file-upload.vue';

// The composable is fully mocked here: its own behavior is already covered by
// useConvertX.test.ts's 55 passing tests. This file exists purely to answer one question -
// "given each of the nine ConvertState values, does the template render sensibly instead of
// falling through to a blank screen?" - which is cheapest to check by controlling `state`
// directly rather than driving the real state machine through a mocked HTTP layer.
vi.mock('./useConvertX', () => ({
  useConvertX: vi.fn(),
}));

vi.mock('./convertx.service', () => ({
  downloadFile: vi.fn(),
}));

interface MockOverrides {
  state?: ConvertState
  targets?: Record<string, string[]>
  converters?: Record<string, string[]>
  results?: ConvertResult[]
  errorMessage?: string
  jobId?: number | null
  isSlow?: boolean
}

function mockConvertX(overrides: MockOverrides = {}) {
  const mocked = {
    state: ref<ConvertState>(overrides.state ?? 'ready'),
    targets: ref<Record<string, string[]>>(overrides.targets ?? {}),
    converters: ref<Record<string, string[]>>(overrides.converters ?? {}),
    results: ref<ConvertResult[]>(overrides.results ?? []),
    errorMessage: ref(overrides.errorMessage ?? ''),
    jobId: ref<number | null>(overrides.jobId ?? null),
    isSlow: ref(overrides.isSlow ?? false),
    selectFile: vi.fn(),
    convert: vi.fn(),
    reset: vi.fn(),
    keepWaiting: vi.fn(),
  };
  vi.mocked(useConvertX).mockReturnValue(mocked);
  return mocked;
}

async function mountInState(overrides: MockOverrides = {}) {
  const mocked = mockConvertX(overrides);
  const wrapper = mount(FileConverter);
  await wrapper.vm.$nextTick();
  return { wrapper, mocked };
}

// c-file-upload emits the picked File directly (see its `fileUpload` event) rather than
// exposing a native <input type="file">.files that jsdom will accept a real FileList for -
// jsdom refuses to programmatically set `.value`/`.files` on a file input. Driving the emit
// directly on the child component is both the reliable path and closer to how the real
// component actually communicates the file.
async function pickFile(wrapper: VueWrapper<any>, file: File) {
  await wrapper.findComponent(CFileUpload).vm.$emit('fileUpload', file);
  await wrapper.vm.$nextTick();
}

// Drives c-select's real DOM structure (see the it-tools specifics this task was briefed
// on: root is c-label, trigger is `.c-select-input`, options live in `.c-select-dropdown`)
// to pick the first available target option, so `selection` becomes non-empty.
async function selectFirstTarget(wrapper: VueWrapper<any>) {
  await wrapper.find('[data-test-id="converter-targets"] .c-select-input').trigger('click');
  await wrapper.find('.c-select-dropdown-option').trigger('click');
  await wrapper.vm.$nextTick();
}

// Every state must produce SOME visible content - guards against a v-if/v-else-if chain that
// silently falls through to nothing.
async function expectNonBlankRender(overrides: MockOverrides) {
  const { wrapper } = await mountInState(overrides);
  expect(wrapper.text().trim().length).toBeGreaterThan(0);
  return wrapper;
}

describe('file-converter states', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('probing: shows a checking indicator', async () => {
    const wrapper = await expectNonBlankRender({ state: 'probing' });
    expect(wrapper.text()).toContain('Checking the converter backend');
  });

  it('probing + isSlow: surfaces the still-trying hint', async () => {
    const wrapper = await expectNonBlankRender({ state: 'probing', isSlow: true });
    expect(wrapper.text()).toContain('Still trying');
  });

  it('unavailable: renders the dedicated test-id hook and no dropzone', async () => {
    const wrapper = await expectNonBlankRender({ state: 'unavailable' });
    expect(wrapper.find('[data-test-id="converter-unavailable"]').exists()).toBe(true);
    expect(wrapper.find('[data-test-id="converter-dropzone"]').exists()).toBe(false);
  });

  it('needs-account: renders explanation and surfaces errorMessage detail', async () => {
    const wrapper = await expectNonBlankRender({ state: 'needs-account', errorMessage: 'Could not start a session' });
    expect(wrapper.text()).toContain('requires an account');
    expect(wrapper.text()).toContain('Could not start a session');
  });

  it('ready: renders the dropzone', async () => {
    const wrapper = await expectNonBlankRender({ state: 'ready' });
    expect(wrapper.find('[data-test-id="converter-dropzone"]').exists()).toBe(true);
  });

  it('loading-targets: after a file is picked, shows a loading indicator and no premature "unsupported" warning', async () => {
    const { wrapper } = await mountInState({ state: 'loading-targets' });

    const file = new File(['x'], 'video.mkv', { type: 'video/x-matroska' });
    await pickFile(wrapper, file);

    expect(wrapper.text()).toContain('Looking up supported output formats');
    expect(wrapper.text()).not.toContain('No converter handles this file type');
  });

  it('ready + empty targets after a file is picked: shows the unsupported-format warning', async () => {
    const { wrapper } = await mountInState({ state: 'ready', targets: {} });

    const file = new File(['x'], 'video.weird', { type: 'application/octet-stream' });
    await pickFile(wrapper, file);

    expect(wrapper.text()).toContain('No converter handles this file type');
  });

  it('ready + populated targets after a file is picked: shows the target select, not the warning', async () => {
    const { wrapper } = await mountInState({ state: 'ready', targets: { ffmpeg: ['mp4', 'webm'] } });

    const file = new File(['x'], 'video.mkv', { type: 'video/x-matroska' });
    await pickFile(wrapper, file);

    expect(wrapper.find('[data-test-id="converter-targets"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('No converter handles this file type');
  });

  it('error after a failed target lookup: shows the real error, not the misleading "unsupported format" warning', async () => {
    // Regression guard for the defect fixed in this task: an 'error' state also leaves
    // targetOptions empty (targets was never populated), but that must not be presented as
    // "this file type isn't supported" - it's a genuine backend/network failure.
    const { wrapper } = await mountInState({
      state: 'error',
      targets: {},
      errorMessage: 'Could not reach the converter backend.',
    });

    const file = new File(['x'], 'video.mkv', { type: 'video/x-matroska' });
    await pickFile(wrapper, file);

    expect(wrapper.text()).toContain('Could not reach the converter backend.');
    expect(wrapper.text()).not.toContain('No converter handles this file type');
  });

  it('converting: shows a converting indicator', async () => {
    const wrapper = await expectNonBlankRender({ state: 'converting', targets: { ffmpeg: ['mp4'] } });
    expect(wrapper.text()).toContain('Converting');
  });

  it('converting + isSlow: surfaces the still-trying hint', async () => {
    const wrapper = await expectNonBlankRender({ state: 'converting', isSlow: true });
    expect(wrapper.text()).toContain('Still trying');
  });

  it('stalled: shows the stall notice, a keep-waiting control, and keeps the target picker visible', async () => {
    // Mounted via a ready -> stalled transition (rather than mounted directly into 'stalled')
    // so a file/targets are actually present to exercise the picker-stays-visible ruling -
    // matching how this state is reached in practice.
    const { wrapper, mocked } = await mountInState({ state: 'ready', targets: { ffmpeg: ['mp4'] } });
    await pickFile(wrapper, new File(['x'], 'video.mkv'));

    mocked.state.value = 'stalled';
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('Still working after 10 minutes');
    expect(wrapper.find('[data-test-id="converter-targets"]').exists()).toBe(true);

    const buttons = wrapper.findAll('button').filter(b => b.text().includes('Keep waiting'));
    expect(buttons.length).toBe(1);
    await buttons[0]!.trigger('click');
    expect(mocked.keepWaiting).toHaveBeenCalledOnce();
  });

  it('converting: the target picker stays visible but Convert is inert while disabled', async () => {
    const { wrapper, mocked } = await mountInState({ state: 'ready', targets: { ffmpeg: ['mp4'] } });
    await pickFile(wrapper, new File(['x'], 'video.mkv'));
    await selectFirstTarget(wrapper);

    mocked.state.value = 'converting';
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-test-id="converter-targets"]').exists()).toBe(true);

    const convertButton = wrapper.findAll('button').find(b => b.text() === 'Convert');
    expect(convertButton).toBeTruthy();
    await convertButton!.trigger('click');

    // The button's own `disabled` prop swallows the click before it ever reaches onConvert() -
    // this is the functional proof the ruling actually works, not just a CSS class check.
    expect(mocked.convert).not.toHaveBeenCalled();
  });

  it('done: renders successful and failed results distinctly, with the result test-id hook and the container-log pointer', async () => {
    const results: ConvertResult[] = [
      { name: 'output.mp4', failed: false, status: 'Done' },
      { name: 'bad.mp4', failed: true, status: 'Failed, check logs' },
    ];
    const wrapper = await expectNonBlankRender({ state: 'done', results, jobId: 42 });

    expect(wrapper.find('[data-test-id="converter-result"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Download output.mp4');
    expect(wrapper.text()).toContain('bad.mp4');
    expect(wrapper.text()).toContain('Failed, check logs');
    expect(wrapper.text()).toContain('Details are in the ConvertX container log.');
  });

  it('done: hides the target picker and Convert button now that results are showing', async () => {
    const { wrapper, mocked } = await mountInState({ state: 'ready', targets: { ffmpeg: ['mp4'] } });
    await pickFile(wrapper, new File(['x'], 'video.mkv'));
    expect(wrapper.find('[data-test-id="converter-targets"]').exists()).toBe(true);

    mocked.state.value = 'done';
    mocked.results.value = [{ name: 'output.mp4', failed: false, status: 'Done' }];
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-test-id="converter-targets"]').exists()).toBe(false);
    expect(wrapper.findAll('button').some(b => b.text() === 'Convert')).toBe(false);
    expect(wrapper.find('[data-test-id="converter-result"]').exists()).toBe(true);
  });

  it('error: renders the error message', async () => {
    const wrapper = await expectNonBlankRender({ state: 'error', errorMessage: 'The conversion failed.' });
    expect(wrapper.text()).toContain('The conversion failed.');
  });

  it('onDownload: a non-expired failure surfaces the service layer\'s own message verbatim', async () => {
    vi.mocked(downloadFile).mockRejectedValueOnce(new Error('Could not reach the converter backend.'));

    const results: ConvertResult[] = [{ name: 'output.mp4', failed: false, status: 'Done' }];
    const { wrapper } = await mountInState({ state: 'done', results, jobId: 42 });

    const downloadButton = wrapper.findAll('button').find(b => b.text().includes('Download output.mp4'));
    expect(downloadButton).toBeTruthy();

    await downloadButton!.trigger('click');
    await flushPromises();

    // The service layer already translated this into a specific, human-readable message -
    // it must reach the user unchanged, not get collapsed into a generic 'Download failed.'
    expect(wrapper.text()).toContain('Could not reach the converter backend.');
    expect(wrapper.text()).not.toContain('Download failed.');
  });

  it('onDownload: the "expired" sentinel is translated into an explanatory message', async () => {
    vi.mocked(downloadFile).mockRejectedValueOnce(new Error('expired'));

    const results: ConvertResult[] = [{ name: 'output.mp4', failed: false, status: 'Done' }];
    const { wrapper } = await mountInState({ state: 'done', results, jobId: 42 });

    const downloadButton = wrapper.findAll('button').find(b => b.text().includes('Download output.mp4'));
    await downloadButton!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('This file has expired. Converted files are kept for about 24 hours.');
  });
});
