<template>
  <footer class="disclaimer-bar" data-testid="disclaimer">
    {{ disclaimer }}
  </footer>
</template>

<script setup lang="ts">
import { GGG_DISCLAIMER } from "@poe2tc/core/operator";

const disclaimer = GGG_DISCLAIMER;
</script>
