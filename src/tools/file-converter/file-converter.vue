<script setup lang="ts">
import { downloadFile } from './convertx.service';
import { useConvertX } from './useConvertX';
import { config } from '@/config';

const { state, targets, converters, results, errorMessage, jobId, isSlow, selectFile, convert, reset, keepWaiting } = useConvertX();

const currentFile = ref<File | null>(null);
const selection = ref<string>('');
const showCapabilities = ref(false);

const targetOptions = computed(() =>
  Object.entries(targets.value).flatMap(([converter, list]) =>
    list.map(target => ({ label: `${target} (${converter})`, value: `${target},${converter}` })),
  ),
);

async function onFileUpload(file: File) {
  currentFile.value = file;
  selection.value = '';
  await selectFile(file);
}

async function onConvert() {
  if (!currentFile.value || !selection.value) {
    return;
  }
  const [target, converter] = selection.value.split(',');
  if (!target || !converter) {
    return;
  }
  await convert(currentFile.value, target, converter);
}

async function onDownload(name: string) {
  if (jobId.value === null) {
    return;
  }

  try {
    const blob = await downloadFile(jobId.value, name);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    try {
      anchor.click();
    }
    finally {
      anchor.remove();
      URL.revokeObjectURL(url);
    }
  }
  catch (error) {
    // 'expired' is a bare sentinel from the service layer, not a message - everything else
    // (network failure, timeout, unreadable response) is already a human-readable string that
    // should be shown verbatim, exactly like every other error path in this component.
    const message = error instanceof Error ? error.message : 'Unexpected error';
    errorMessage.value = message === 'expired'
      ? 'This file has expired. Converted files are kept for about 24 hours.'
      : message;
  }
}

function startOver() {
  currentFile.value = null;
  selection.value = '';
  reset();
}
</script>

<template>
  <c-card v-if="state === 'probing'" title="File converter">
    <n-spin size="small" /> Checking the converter backend…
    <span v-if="isSlow" op-70>
      Still trying — a cold backend can take a little while to respond.
    </span>
  </c-card>

  <c-card v-else-if="state === 'unavailable'" title="Converter backend not reachable" data-test-id="converter-unavailable">
    <p>
      No ConvertX backend responded at <code>{{ config.app.convertxUrl }}</code>.
    </p>
    <p>
      This tool needs the companion ConvertX service. Start the full stack with
      <code>docker compose up</code>, or set <code>VITE_CONVERTX_URL</code> at build time
      if your backend lives elsewhere.
    </p>
  </c-card>

  <c-card v-else-if="state === 'needs-account'" title="Converter backend requires an account">
    <p>
      The backend responded but rejected an anonymous session. This tool only supports
      backends running with <code>ALLOW_UNAUTHENTICATED=true</code>.
    </p>
    <p v-if="errorMessage" op-70>
      {{ errorMessage }}
    </p>
  </c-card>

  <template v-else>
    <c-card title="File converter">
      <c-file-upload
        title="Drag and drop a file here, or click to select a file"
        data-test-id="converter-dropzone"
        @file-upload="onFileUpload"
      />

      <div v-if="currentFile" mt-3>
        <p><strong>{{ currentFile.name }}</strong></p>

        <div v-if="state === 'loading-targets'">
          <n-spin size="small" /> Looking up supported output formats…
          <span v-if="isSlow" op-70>
            Still trying — a cold backend can take a little while to respond.
          </span>
        </div>

        <!--
          Hidden once `state === 'done'`: a live Convert control sitting under a finished
          conversion's results invites a second click that does nothing useful. Visible-but-
          disabled during `converting`/`stalled` so the user can still see what they chose while
          it runs; still visible and enabled for `error`, since that is the recoverable case
          where re-picking a target and retrying is the point.
        -->
        <template v-else-if="targetOptions.length > 0 && state !== 'done'">
          <div :class="{ 'pointer-events-none op-50': state === 'converting' || state === 'stalled' }">
            <c-select
              v-model:value="selection"
              :options="targetOptions"
              label="Convert to"
              placeholder="Choose an output format"
              data-test-id="converter-targets"
              my-2
            />
            <c-button :disabled="!selection || state === 'converting' || state === 'stalled'" @click="onConvert()">
              Convert
            </c-button>
          </div>
        </template>

        <!--
          Only render the "unsupported format" warning when the target lookup actually
          succeeded with zero results (state === 'ready'). A failed lookup (state ===
          'error') also leaves targetOptions empty, but for an unrelated reason — a
          network/session failure, already surfaced by the errorMessage alert below.
          Showing this warning in that case would falsely blame the file's format.
        -->
        <n-alert v-else-if="state === 'ready'" type="warning" mt-2>
          No converter handles this file type. Check the supported formats below — detection is
          based on the file extension, so an unusual or missing extension is a common cause.
        </n-alert>
      </div>

      <div v-if="state === 'converting'" mt-3>
        <n-spin size="small" /> Converting…
        <span v-if="isSlow" op-70>
          Still trying — this can take a while against a slow or cold backend.
        </span>
      </div>

      <n-alert v-if="state === 'stalled'" type="warning" mt-3>
        <p>Still working after 10 minutes. Large videos and LaTeX documents can legitimately take this long.</p>
        <c-button mt-2 @click="keepWaiting()">
          Keep waiting
        </c-button>
      </n-alert>

      <n-alert v-if="errorMessage" type="error" mt-3>
        {{ errorMessage }}
      </n-alert>

      <div v-if="state === 'done'" mt-3 data-test-id="converter-result">
        <div v-for="result in results" :key="result.name" mb-2>
          <template v-if="result.failed">
            <n-alert type="error">
              {{ result.name }} — {{ result.status }}. Details are in the ConvertX container log.
            </n-alert>
          </template>
          <template v-else>
            <c-button @click="onDownload(result.name)">
              Download {{ result.name }}
            </c-button>
            <span v-if="result.status !== 'Done'" ml-2 op-70>{{ result.status }}</span>
          </template>
        </div>
        <c-button mt-2 @click="startOver()">
          Convert another file
        </c-button>
      </div>
    </c-card>

    <c-card title="Supported formats">
      <c-button @click="showCapabilities = !showCapabilities">
        {{ showCapabilities ? 'Hide' : 'Show' }} what each converter handles
      </c-button>
      <n-table v-if="showCapabilities" mt-3>
        <thead>
          <tr><th>Converter</th><th>Output formats</th></tr>
        </thead>
        <tbody>
          <tr v-for="(list, name) in converters" :key="name">
            <td>{{ name }}</td>
            <td>{{ list.join(', ') }}</td>
          </tr>
        </tbody>
      </n-table>
    </c-card>
  </template>
</template>
