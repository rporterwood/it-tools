<script setup lang="ts">
import type { QRCodeErrorCorrectionLevel } from 'qrcode';
import { LOGO_SIZE_PERCENT } from './qr-code-logo.service';
import QrLogoPicker from './qr-logo-picker.vue';
import QrScanStatus from './qr-scan-status.vue';
import { useQRCode } from './useQRCode';
import { useDownloadFileFromBase64 } from '@/composable/downloadBase64';

const foreground = ref('#000000ff');
const background = ref('#ffffffff');
const errorCorrectionLevel = ref<QRCodeErrorCorrectionLevel>('medium');

const errorCorrectionLevels = ['low', 'medium', 'quartile', 'high'];

const logoImage = shallowRef<HTMLImageElement | null>(null);
const logoSizePercent = ref(LOGO_SIZE_PERCENT.default);

const text = ref('https://it-tools.tech');
const { qrcode, decodes, renderError } = useQRCode({
  text,
  color: {
    background,
    foreground,
  },
  errorCorrectionLevel,
  options: { width: 2048 },
  logo: { image: logoImage, sizePercent: logoSizePercent },
});

const { download } = useDownloadFileFromBase64({ source: qrcode, filename: 'qr-code.png' });
</script>

<template>
  <c-card>
    <n-grid x-gap="12" y-gap="12" cols="1 600:3">
      <n-gi span="2">
        <c-input-text
          v-model:value="text"
          label-position="left"
          label-width="130px"
          label-align="right"
          label="Text:"
          multiline
          rows="1"
          autosize
          placeholder="Your link or text..."
          mb-6
        />
        <n-form label-width="130" label-placement="left">
          <n-form-item label="Foreground color:">
            <n-color-picker v-model:value="foreground" :modes="['hex']" />
          </n-form-item>
          <n-form-item label="Background color:">
            <n-color-picker v-model:value="background" :modes="['hex']" />
          </n-form-item>
          <QrLogoPicker v-model:image="logoImage" v-model:size-percent="logoSizePercent" />
          <n-form-item v-if="logoImage" label="Error resistance:">
            <span data-test-id="qr-logo-correction-note">high (set automatically while a logo is on)</span>
          </n-form-item>
          <c-select
            v-else
            v-model:value="errorCorrectionLevel"
            label="Error resistance:"
            label-position="left"
            label-width="130px"
            label-align="right"
            :options="errorCorrectionLevels.map((value) => ({ label: value, value }))"
          />
        </n-form>
      </n-gi>
      <n-gi>
        <div flex flex-col items-center gap-3>
          <n-image :src="qrcode" width="200" />
          <QrScanStatus :decodes="decodes" :render-error="renderError" />
          <c-button :disabled="!qrcode" @click="download">
            Download qr-code
          </c-button>
        </div>
      </n-gi>
    </n-grid>
  </c-card>
</template>
