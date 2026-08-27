<template>
  <section>
    <h2>Catalog</h2>
    <p class="muted">Local observed items. No undocumented trade-site sync.</p>
    <table data-testid="catalog-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Class</th>
          <th>Rarity</th>
          <th>Fingerprint</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="operatorState.catalog.length === 0">
          <td colspan="4" class="muted">No catalog items yet. Parse an item from Price check.</td>
        </tr>
        <tr v-for="entry in operatorState.catalog" :key="entry.fingerprint">
          <td>{{ entry.item.name ?? "—" }}</td>
          <td>{{ entry.item.class ?? "—" }}</td>
          <td>{{ entry.item.rarity ?? "—" }}</td>
          <td>{{ entry.fingerprint.slice(0, 12) }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import { onMounted } from "vue";
import { operatorState, refreshCatalog } from "../operatorState.js";

onMounted(() => {
  void refreshCatalog();
});
</script>
