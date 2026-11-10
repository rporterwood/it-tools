<script setup lang="ts">
defineProps<{
  decodes?: boolean
  renderError?: string
}>();
</script>

<template>
  <n-alert v-if="renderError" type="error" :show-icon="false" data-test-id="qr-render-error">
    {{ renderError }}
  </n-alert>
  <div v-else-if="decodes === true" data-test-id="qr-scan-status">
    &#10003; Scan check: reads correctly
  </div>
  <c-alert v-else-if="decodes === false" type="warning" data-test-id="qr-scan-status">
    Scan check: this code may not scan. Try a smaller logo or more contrast, and test it with a phone before printing.
  </c-alert>
</template>
