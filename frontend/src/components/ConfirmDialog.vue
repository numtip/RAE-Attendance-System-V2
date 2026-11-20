<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';

// Modal confirmation on the native <dialog>: the browser traps focus, makes the page behind inert, closes on Esc
// and returns focus to the control that opened it. Cancel is focused first so Enter never confirms by accident.
const props = defineProps<{ open: boolean; title: string; confirmLabel: string; busy?: boolean }>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const cancelButton = ref<HTMLButtonElement | null>(null);

watch(() => props.open, async (open) => {
  const el = dialog.value;
  if (!el) return;
  if (open && !el.open) {
    el.showModal();
    await nextTick();
    cancelButton.value?.focus();
  } else if (!open && el.open) {
    el.close();
  }
});

function onClose() {
  // Esc (or the browser) closed the dialog while the parent still thinks it is open.
  if (props.open) emit('cancel');
}
function onBackdrop(event: MouseEvent) {
  if (event.target === dialog.value && !props.busy) emit('cancel');
}
</script>

<template>
  <dialog ref="dialog" class="dialog" aria-labelledby="confirm-title" @close="onClose" @click="onBackdrop">
    <div class="dialog-body">
      <h3 id="confirm-title">{{ title }}</h3>
      <div class="dialog-content"><slot /></div>
      <div class="dialog-actions">
        <button ref="cancelButton" type="button" class="btn btn--ghost" :disabled="busy" @click="emit('cancel')">ยกเลิก</button>
        <button type="button" class="btn btn--primary" :disabled="busy" @click="emit('confirm')">
          {{ busy ? 'กำลังบันทึก…' : confirmLabel }}
        </button>
      </div>
    </div>
  </dialog>
</template>
