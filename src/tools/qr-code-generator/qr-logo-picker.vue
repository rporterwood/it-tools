<script setup lang="ts">
import { useVModel } from '@vueuse/core';
import { LOGO_FILE_ACCEPT, LOGO_SIZE_PERCENT, getLogoFileError, loadLogoImage } from './qr-code-logo.service';

const props = defineProps<{
  image: HTMLImageElement | null
  sizePercent: number
}>();
const emit = defineEmits(['update:image', 'update:sizePercent']);

const image = useVModel(props, 'image', emit);
const sizePercent = useVModel(props, 'sizePercent', emit);

const fileInput = ref<HTMLInputElement | null>(null);
const fileName = ref('');
const error = ref<string>();

async function useFile(file: File) {
  const fileError = getLogoFileError(file);
  if (fileError) {
    error.value = fileError;
    return;
  }

  try {
    image.value = await loadLogoImage(file);
    fileName.value = file.name;
    error.value = undefined;
  }
  catch {
    error.value = 'This image could not be read.';
  }
}

function onFileChosen(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  // Clearing the input lets the same file be chosen again after removing it
  input.value = '';

  if (file) {
    useFile(file);
  }
}

function removeLogo() {
  image.value = null;
  fileName.value = '';
  error.value = undefined;
}
</script>

<template>
  <n-form-item label="Logo:" :show-feedback="!error" :validation-status="error ? 'error' : undefined">
    <div flex flex-wrap items-center gap-3>
      <input
        ref="fileInput"
        data-test-id="qr-logo-input"
        type="file"
        class="hidden"
        :accept="LOGO_FILE_ACCEPT"
        @change="onFileChosen"
      >
      <c-button @click="fileInput?.click()">
        Choose image
      </c-button>
      <span v-if="image" max-w-200px truncate>{{ fileName }}</span>
      <c-button v-if="image" variant="text" data-test-id="qr-logo-remove" @click="removeLogo">
        Remove
      </c-button>
    </div>
  </n-form-item>
  <n-alert v-if="error" type="error" :show-icon="false" mb-4 data-test-id="qr-logo-error">
    {{ error }}
  </n-alert>
  <n-form-item v-if="image" label="Logo size:">
    <n-slider v-model:value="sizePercent" :step="1" :min="LOGO_SIZE_PERCENT.min" :max="LOGO_SIZE_PERCENT.max" />
    <span ml-3 w-40px flex-none text-right>{{ sizePercent }}%</span>
  </n-form-item>
</template>
