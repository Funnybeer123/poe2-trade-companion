/**
 * Feature module "chatCommands": provides the chat command service
 * (`ctx.require("chatCommands")`), the `chat:*` channels and the
 * "chat-commands" settings namespace. Registered after the overlay/hotkey
 * foundations so later modules (trade, commands, market) can send lines.
 */
import { normalizeChatCommandSettings } from "../../../core/chatCommands.js";
import type {
  ChatCommandRequest,
  ChatCommandSettings,
  ChatCopyRequest,
  PlaceholderContext,
  StashSearchOptions,
} from "../../../shared/chatCommands.js";
import { ChatCommandServiceImpl, type ChatCommandService } from "../../chatCommandService.js";
import type { FeatureModule } from "../types.js";

declare module "../types.js" {
  interface FeatureServiceMap {
    chatCommands: ChatCommandService;
  }
}

export const CHAT_COMMANDS_SETTINGS_ID = "chat-commands";

/** The one thing this module reads from the client-log foundation, typed loosely so it registers without it. */
interface ClientLogLike {
  status(): { gameSettings?: { searchKey?: number } };
}

export const chatCommandsModule: FeatureModule = {
  id: "chatCommands",
  register(ctx) {
    const settings = ctx.settings.namespace<ChatCommandSettings>(CHAT_COMMANDS_SETTINGS_ID, (raw) => {
      const { value, issues } = normalizeChatCommandSettings(raw);
      if (issues.length > 0) {
        ctx.log({ feature: "chatCommands", level: "warn", message: "settings sanitized", detail: issues });
      }
      return value;
    });
    // The client-log module is optional at registration time (and its
    // FeatureServiceMap key lives in its own file), so look it up loosely.
    const getService = ctx.get as unknown as (id: string) => unknown;
    const clientLog = () => getService("clientLog") as ClientLogLike | undefined;

    const service = new ChatCommandServiceImpl({
      userDataDir: ctx.userDataDir,
      buildMode: ctx.buildMode,
      killSwitchLatched: () => ctx.killSwitchLatched(),
      dryRun: () => ctx.dryRun(),
      settings: () => settings.get(),
      searchKey: () => clientLog()?.status().gameSettings?.searchKey,
      // Dry-run copy-hovered answers from this process's clipboard: no host
      // may start, so the game is never asked for the item text.
      readClipboard: () => ctx.clipboard.readText(),
      onOutcome: (outcome) => ctx.emit("chat:sent", outcome),
      onStatus: (status) => ctx.emit("chat:status", status),
      log: (level, message, detail) => ctx.log({ feature: "chatCommands", level, message, detail }),
    });
    ctx.provide("chatCommands", service);

    ctx.handle("chat:send", (request: ChatCommandRequest) => service.send(request));
    ctx.handle("chat:stash-search", (text: string, reason: string, options?: StashSearchOptions) =>
      service.stashSearch(text, reason, options),
    );
    ctx.handle("chat:copy-hovered", (request: ChatCopyRequest) => service.copyHoveredItem(request));
    ctx.handle("chat:status", () => service.status());
    ctx.handle("chat:resolve", (template: string, context: PlaceholderContext) =>
      service.resolvePlaceholders(template, context ?? {}),
    );
    const stopSettings = settings.onChange(() => service.announce());

    return {
      dispose: async () => {
        stopSettings();
        await service.dispose();
      },
    };
  },
};
