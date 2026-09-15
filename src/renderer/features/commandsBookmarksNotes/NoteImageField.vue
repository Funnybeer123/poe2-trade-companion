<script setup lang="ts">
/**
 * One optional image per note. The file never leaves the machine: it is read
 * as a data URI and handed to main, which re-checks the type and the size and
 * stores the bytes beside the settings file.
 */
import { computed, ref } from "vue";
import {
  NOTE_IMAGE_MAX_BYTES,
  NOTE_IMAGE_MIMES,
} from "@core/commandsBookmarksNotes";
import type { NoteImageMeta } from "../../../shared/commandsBookmarksNotes.js";

const props = defineProps<{
  image?: NoteImageMeta;
  dataUri?: string;
  busy: boolean;
  /** An image belongs to a note main already knows; a new row has none yet. */
  saved: boolean;
  noteTitle: string;
}>();

const emit = defineEmits<{
  image: [dataUri: string];
  remove: [];
  error: [message: string];
}>();

const reading = ref(false);

const sizeText = computed(() => {
  if (!props.image) return "";
  const kb = props.image.bytes / 1024;
  const size = kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`;
  const dims = props.image.width && props.image.height ? ` · ${props.image.width}×${props.image.height}` : "";
  return `${size}${dims}`;
});

function onChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  try {
    input.value = "";
  } catch {
    // Some engines refuse to clear a file input; picking the same file twice
    // is the only thing that suffers.
  }
  if (!file) return;
  if (!(NOTE_IMAGE_MIMES as readonly string[]).includes(file.type)) {
    emit("error", `${file.type || "that file"} is not supported (PNG, JPEG, WebP or GIF only).`);
    return;
  }
  if (file.size > NOTE_IMAGE_MAX_BYTES) {
    emit("error", `The image is ${(file.size / (1024 * 1024)).toFixed(1)} MB (limit 2 MB).`);
    return;
  }
  reading.value = true;
  const reader = new FileReader();
  reader.onerror = () => {
    reading.value = false;
    emit("error", "The image could not be read.");
  };
  reader.onload = () => {
    reading.value = false;
    const result = typeof reader.result === "string" ? reader.result : "";
    if (result) emit("image", result);
    else emit("error", "The image could not be read.");
  };
  reader.readAsDataURL(file);
}
</script>

<template>
  <div class="note-image-field">
    <label>
      <span>Image (optional, max 2 MB)</span>
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        :disabled="busy || reading || !saved"
        :title="saved ? '' : 'Save the note first.'"
        @change="onChange"
      />
    </label>
    <p v-if="!saved" class="muted">Save the note first — then an image can be attached to it.</p>
    <div v-if="image" class="note-image-preview">
      <img v-if="dataUri" :src="dataUri" :alt="`Image of ${noteTitle}`" />
      <span class="muted">{{ sizeText }}</span>
      <button type="button" class="button compact ghost" :disabled="busy" @click="emit('remove')">
        Remove image
      </button>
    </div>
  </div>
</template>

<style scoped>
.note-image-field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.note-image-preview {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.75rem;
}
.note-image-preview img {
  max-width: 120px;
  max-height: 90px;
  border: 1px solid var(--line, #2b3038);
  border-radius: 6px;
}
</style>
