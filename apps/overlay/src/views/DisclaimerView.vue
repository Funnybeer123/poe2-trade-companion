<template>
  <section>
    <h2>Disclaimer</h2>
    <div class="panel" data-testid="disclaimer-view">
      <p>{{ disclaimer }}</p>
      <p class="muted">
        Public companion mode stays within published GGG third-party/macro guidance. Authorized QA
        automation requires explicit local acknowledgement, a persistent banner, and the emergency stop.
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { GGG_DISCLAIMER } from "@poe2tc/core/operator";

const disclaimer = GGG_DISCLAIMER;
</script>
