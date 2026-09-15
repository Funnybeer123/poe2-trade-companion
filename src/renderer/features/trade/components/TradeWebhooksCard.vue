<script setup lang="ts">
/**
 * The ONE place the Discord webhook URL / Telegram bot token / chat id are
 * entered. They are stored in `trade-webhooks.secret.json` under the Windows
 * profile — never in companion-settings.json, never under the repo, never
 * shown again. The card is self-contained so Tools → Settings mounts it with
 * no props, next to the market-data cookie.
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useTradeStore } from "../api/useTradeStore";

const store = useTradeStore();
const discordUrl = ref("");
const telegramToken = ref("");
const telegramChatId = ref("");

onMounted(async () => {
  await store.initializeTradeStore();
  await store.loadWebhooks();
});
onBeforeUnmount(() => store.disposeTradeStore());

async function save(): Promise<void> {
  const patch: Record<string, string | null> = {};
  if (discordUrl.value.trim()) patch.discordWebhookUrl = discordUrl.value.trim();
  if (telegramToken.value.trim()) patch.telegramBotToken = telegramToken.value.trim();
  if (telegramChatId.value.trim()) patch.telegramChatId = telegramChatId.value.trim();
  await store.saveWebhooks(patch);
  discordUrl.value = "";
  telegramToken.value = "";
  telegramChatId.value = "";
}

async function clearAll(): Promise<void> {
  await store.saveWebhooks({ discordWebhookUrl: null, telegramBotToken: null, telegramChatId: null });
  discordUrl.value = "";
  telegramToken.value = "";
  telegramChatId.value = "";
}

async function toggleTarget(target: "discord" | "telegram", value: boolean): Promise<void> {
  const webhooks = { ...store.settings.value.webhooks, [target]: value };
  await store.saveSettings({ webhooks });
}

async function toggleName(value: boolean): Promise<void> {
  const webhooks = { ...store.settings.value.webhooks, includePlayerName: value };
  await store.saveSettings({ webhooks });
}

function chipTone(configured: boolean, lastOk?: boolean): string {
  if (!configured) return "neutral";
  return lastOk === false ? "danger" : "safe";
}
</script>

<template>
  <section class="card tool-panel trade-webhooks" aria-labelledby="trade-webhooks-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Trade</span>
        <h3 id="trade-webhooks-title">Trade webhooks</h3>
      </div>
      <span class="status-chip neutral">Your own endpoints</span>
    </div>

    <div v-if="!store.available" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">◇</span>
      <strong>Trade webhooks need the desktop app</strong>
      <p>This preview has no bridge.</p>
    </div>

    <template v-else>
      <p class="muted">
        One message per new offer to a Discord webhook or Telegram bot you created. Stored only in
        trade-webhooks.secret.json under your Windows profile; never shown again, never synced, never sent
        anywhere else.
      </p>
      <p class="privacy-note">
        Each message contains the item, price, league and stash position from the whisper — and the other
        player's character name unless you untick it below.
      </p>

      <div class="form-grid">
        <label>
          Discord webhook URL
          <input
            v-model="discordUrl"
            type="password"
            autocomplete="off"
            placeholder="https://discord.com/api/webhooks/…"
          />
        </label>
        <label class="toggle-field">
          <input
            type="checkbox"
            :checked="store.settings.value.webhooks.discord"
            @change="toggleTarget('discord', ($event.target as HTMLInputElement).checked)"
          />
          Send to Discord
        </label>
        <label>
          Telegram bot token
          <input v-model="telegramToken" type="password" autocomplete="off" placeholder="123456:AA…" />
        </label>
        <label>
          Telegram chat id
          <input v-model="telegramChatId" type="password" autocomplete="off" placeholder="-1001234567890" />
        </label>
        <label class="toggle-field">
          <input
            type="checkbox"
            :checked="store.settings.value.webhooks.telegram"
            @change="toggleTarget('telegram', ($event.target as HTMLInputElement).checked)"
          />
          Send to Telegram
        </label>
        <label class="toggle-field">
          <input
            type="checkbox"
            :checked="store.settings.value.webhooks.includePlayerName"
            @change="toggleName(($event.target as HTMLInputElement).checked)"
          />
          Include the other player's name
        </label>
      </div>

      <div class="button-row">
        <button type="button" class="button secondary compact" :disabled="store.busy.value" @click="save">
          Save webhooks
        </button>
        <button type="button" class="button ghost compact" :disabled="store.busy.value" @click="store.testWebhook('discord')">
          Test Discord
        </button>
        <button type="button" class="button ghost compact" :disabled="store.busy.value" @click="store.testWebhook('telegram')">
          Test Telegram
        </button>
        <button type="button" class="button ghost compact" :disabled="store.busy.value" @click="clearAll">
          Clear saved secrets
        </button>
      </div>

      <p v-if="store.webhooks.value" class="chip-row">
        <span class="status-chip" :class="chipTone(store.webhooks.value.discord.configured, store.webhooks.value.discord.lastOk)">
          Discord:
          {{ store.webhooks.value.discord.configured ? "configured" : "not configured" }}
          {{ store.webhooks.value.discord.lastError ? `· ${store.webhooks.value.discord.lastError}` : "" }}
        </span>
        <span class="status-chip" :class="chipTone(store.webhooks.value.telegram.configured, store.webhooks.value.telegram.lastOk)">
          Telegram:
          {{ store.webhooks.value.telegram.configured ? "configured" : "not configured" }}
          {{ store.webhooks.value.telegram.lastError ? `· ${store.webhooks.value.telegram.lastError}` : "" }}
        </span>
      </p>

      <p v-if="store.notice.value" class="inline-notice" role="status">{{ store.notice.value }}</p>
      <p v-if="store.error.value" class="inline-notice danger" role="alert">{{ store.error.value }}</p>
      <p class="disclaimer">
        Messages go out at most ten a minute per target, never retried, and redirects are refused.
      </p>
    </template>
  </section>
</template>

<style scoped>
.trade-webhooks {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin: 0;
}
</style>
