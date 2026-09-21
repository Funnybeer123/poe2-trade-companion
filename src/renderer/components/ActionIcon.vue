<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 });
const paths: Record<string, string> = {
  dashboard: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  sort: 'M4 6h16 M4 12h11 M4 18h6 M18 12v9 m-3-3 3 3 3-3',
  shop: 'M3 9l2-5h14l2 5 M3 9v3a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0V9 M5 15v6h14v-6 M9 21v-5h6v5',
  items: 'M5 3h14v18H5z M9 7h6 M9 12h6 M9 17h4',
  search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  builds: 'M12 3l9 5-9 5-9-5z M3 12l9 5 9-5 M3 16l9 5 9-5',
  settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
  health: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z',
  mana: 'M12 3S5 10.5 5 15a7 7 0 0 0 14 0c0-4.5-7-12-7-12z M9 15a3 3 0 0 0 3 3',
  unleash: 'M13 2L4 14h7l-1 8 10-13h-7z',
  verisium: 'M12 2v3 M12 19v3 M2 12h3 M19 12h3 M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z M9.5 12a2.5 2.5 0 0 1 2.5-2.5',
  down: 'M12 3v12 m-5-5 5 5 5-5 M4 16v5h16v-5',
  up: 'M12 15V3 m-5 5 5-5 5 5 M4 16v5h16v-5',
  repeat: 'M3 8h14a4 4 0 0 1 4 4 M7 4 3 8l4 4 M21 16H7a4 4 0 0 1-4-4 m14 0 4 4-4 4',
  scan: 'M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5 M7 8h10 M7 12h10 M7 16h6',
  voice: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0z M5 10v2a7 7 0 0 0 14 0v-2 M12 19v3 M8 22h8',
  craft: 'M14 3l7 7-5 5-7-7z M11 10l-9 9 3 3 9-9 M15 2l7 7',
  maps: 'M9 4l6 2 6-2v16l-6 2-6-2-6 2V6z M9 4v16 M15 6v16',
  arrow: 'M5 12h14 m-5-5 5 5-5 5',
  play: 'M7 4l14 8-14 8z',
  pause: 'M8 4v16 M16 4v16',
  stop: 'M5 5h14v14H5z',
};
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.dashboard" /></svg>
</template>
