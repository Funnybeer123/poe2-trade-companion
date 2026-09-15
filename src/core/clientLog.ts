/**
 * Pure parser for Path of Exile 2's `logs/Client.txt`.
 *
 * Every line the game writes starts with the same prefix
 * (`2026/09/11 20:52:15 40206281 2caa229f [DEBUG Client 23032] `); what
 * follows is either a system message (`: Trade accepted.`), a chat line
 * (`@From Name: …`, `#Name: …`), or engine chatter we ignore. PoE2 has NO
 * "You have entered" line — area changes are the DEBUG "Generating level N
 * area" line, whose N is the area's monster level.
 *
 * Trade whispers are the trade site's fixed templates, one per client
 * language. Only the English templates were observed in a real log; the
 * other languages are transcribed from the trade site as best known and
 * are marked untested. Whisper direction is anchored on the `@From ` /
 * `@To ` token right after the `] ` bracket because global chat text
 * routinely contains "@".
 *
 * No I/O, no Electron: the main-process service (src/main/features/clientLog)
 * feeds lines in and re-emits the events.
 */

export type AreaCategory =
  | "town"
  | "hideout"
  | "campaign"
  | "map"
  | "league"
  | "sanctum"
  | "endgame-town"
  | "other";

export interface AreaInfo {
  id: string;
  name: string;
  category: AreaCategory;
  act?: number;
  part?: 1 | 2;
  isCruel?: boolean;
  /** Typical monster level from the catalogue (campaign/town entries). */
  level?: number;
  /** The display name is a humanized guess, not a verified in-game name. */
  unverified?: boolean;
}

export type ChatChannel = "global" | "trade" | "guild" | "party" | "local";

export type ClientLogEvent =
  | { kind: "area"; at: string; areaId: string; level: number; seed: number; info: AreaInfo }
  | { kind: "instance"; at: string; address: string }
  | { kind: "level-up"; at: string; character: string; className: string; level: number }
  | { kind: "death"; at: string; character: string }
  | {
      kind: "whisper";
      at: string;
      direction: "in" | "out";
      player: string;
      text: string;
      trade?: TradeWhisper;
      /** Guild tag shown before the name (`@From <TAG> Name:`), when present. */
      guildTag?: string;
    }
  | { kind: "trade"; at: string; result: "accepted" | "cancelled" }
  | { kind: "afk"; at: string; on: boolean; autoreply?: string }
  | { kind: "area-join"; at: string; player: string; joined: boolean }
  | { kind: "party"; at: string; player: string; action: "joined" | "left" | "kicked" }
  | { kind: "chat"; at: string; channel: ChatChannel; player: string; text: string; guildTag?: string }
  | { kind: "player-not-found"; at: string };

export type ClientLogEventKind = ClientLogEvent["kind"];

export interface TradeWhisper {
  kind: "item" | "bulk";
  /** "en", "ru", "pt", "ko", "de", "fr", "es", "th", "ja", "zh-Hans", "zh-Hant" */
  language: string;
  /** Rare/magic/unique name, or the base for normal items; the wanted item for bulk. */
  itemName?: string;
  baseType?: string;
  /** Bulk: how many of the item the buyer wants. */
  quantity?: number;
  /** As written: "1 exalted", "20 Exalted Orb". */
  price: { amount: number; currency: string };
  league: string;
  stashTab?: string;
  position?: { left: number; top: number };
  raw: string;
}

// ---------------------------------------------------------------------------
// Line prefix
// ---------------------------------------------------------------------------

export interface ClientLogLinePrefix {
  /** ISO timestamp; the log's wall-clock time interpreted in the local timezone. */
  at: string;
  level: string;
  /** Process id from `[INFO Client 23032]`. */
  pid: number;
  /** Everything after the `] `. */
  rest: string;
}

const PREFIX =
  /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2}) \d+ [0-9a-f]+ \[(\w+) Client (\d+)\] (.*)$/;

/** Splits the fixed prefix off a line; undefined for anything that is not a log line. */
export function parseClientLogPrefix(line: string): ClientLogLinePrefix | undefined {
  const match = PREFIX.exec(line.replace(/\r$/, ""));
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, level, pid, rest] = match;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  if (Number.isNaN(date.getTime())) return undefined;
  return { at: date.toISOString(), level, pid: Number(pid), rest };
}

// ---------------------------------------------------------------------------
// System messages (`: …`)
// ---------------------------------------------------------------------------

const AREA = /^Generating level (\d+) area "([^"]+)" with seed (\d+)\s*$/;
const INSTANCE = /^Connecting to instance server at (\S+)\s*$/;
const LEVEL_UP = /^: (.+?) \((.+?)\) is now level (\d+)\.?$/;
const DEATH = /^: (.+?) has been slain\.$/;
const TRADE = /^: Trade (accepted|cancelled)\.$/;
const AREA_JOIN = /^: (.+?) has (joined|left) the area\.$/;
const PARTY = /^: (.+?) has (joined|left) the party\.$/;
/** Untested in PoE2: transcribed from the PoE1 message. */
const PARTY_KICK = /^: (.+?) has been kicked from the party\.$/;
const AFK_ON = /^: AFK mode is now ON\.(?: Autoreply "(.*)")?$/;
const AFK_OFF = /^: AFK mode is now OFF\.$/;
/** Untested in PoE2: the PoE1 wordings for a whisper to an offline player. */
const PLAYER_NOT_FOUND =
  /^: (?:Player not found|That player is not online|That character is not online|.+? is not online)\.$/;

/** `@From <TAG> Name: text` — the guild tag is optional. */
const WHISPER = /^@(From|To) (?:<([^>]+)> )?(\S+): (.*)$/;
/** `#Name: text` — global `#`, trade `$`, guild `&`, party `%`. */
const CHANNEL_CHAT = /^([#$&%])(?:<([^>]+)> )?(\S+): (.*)$/;
/** Local chat has no prefix: `Name: text`. Names are one token, so engine lines ("Tile hash: 1") do not match. */
const LOCAL_CHAT = /^(?:<([^>]+)> )?([A-Za-z0-9_]{1,40}): (.*)$/;

const CHANNEL_BY_PREFIX: Record<string, ChatChannel> = {
  "#": "global",
  $: "trade",
  "&": "guild",
  "%": "party",
};

/**
 * Parses one raw line into a typed event, or undefined for engine chatter.
 * `areaInfoFor` lets the caller resolve the area catalogue without a
 * circular import; the default is a bare "other" entry.
 */
export function parseClientLogLine(
  line: string,
  areaInfoFor: (areaId: string) => AreaInfo = bareAreaInfo,
): ClientLogEvent | undefined {
  const prefix = parseClientLogPrefix(line);
  if (!prefix) return undefined;
  const { at, rest, level } = prefix;

  if (level === "DEBUG") {
    const area = AREA.exec(rest);
    if (area) {
      return {
        kind: "area",
        at,
        areaId: area[2],
        level: Number(area[1]),
        seed: Number(area[3]),
        info: areaInfoFor(area[2]),
      };
    }
    return undefined;
  }

  const instance = INSTANCE.exec(rest);
  if (instance) return { kind: "instance", at, address: instance[1] };

  if (rest.startsWith(": ")) {
    const levelUp = LEVEL_UP.exec(rest);
    if (levelUp) {
      return { kind: "level-up", at, character: levelUp[1], className: levelUp[2], level: Number(levelUp[3]) };
    }
    const death = DEATH.exec(rest);
    if (death) return { kind: "death", at, character: death[1] };
    const trade = TRADE.exec(rest);
    if (trade) return { kind: "trade", at, result: trade[1] as "accepted" | "cancelled" };
    const areaJoin = AREA_JOIN.exec(rest);
    if (areaJoin) return { kind: "area-join", at, player: areaJoin[1], joined: areaJoin[2] === "joined" };
    const party = PARTY.exec(rest);
    if (party) return { kind: "party", at, player: party[1], action: party[2] as "joined" | "left" };
    const kicked = PARTY_KICK.exec(rest);
    if (kicked) return { kind: "party", at, player: kicked[1], action: "kicked" };
    const afkOn = AFK_ON.exec(rest);
    if (afkOn) return { kind: "afk", at, on: true, autoreply: afkOn[1] };
    if (AFK_OFF.test(rest)) return { kind: "afk", at, on: false };
    if (PLAYER_NOT_FOUND.test(rest)) return { kind: "player-not-found", at };
    return undefined;
  }

  const whisper = WHISPER.exec(rest);
  if (whisper) {
    const text = whisper[4];
    const event: Extract<ClientLogEvent, { kind: "whisper" }> = {
      kind: "whisper",
      at,
      direction: whisper[1] === "From" ? "in" : "out",
      player: whisper[3],
      text,
    };
    if (whisper[2]) event.guildTag = whisper[2];
    const trade = parseTradeWhisper(text);
    if (trade) event.trade = trade;
    return event;
  }

  const channel = CHANNEL_CHAT.exec(rest);
  if (channel) {
    const event: Extract<ClientLogEvent, { kind: "chat" }> = {
      kind: "chat",
      at,
      channel: CHANNEL_BY_PREFIX[channel[1]],
      player: channel[3],
      text: channel[4],
    };
    if (channel[2]) event.guildTag = channel[2];
    return event;
  }

  if (level === "INFO") {
    const local = LOCAL_CHAT.exec(rest);
    if (local) {
      const event: Extract<ClientLogEvent, { kind: "chat" }> = {
        kind: "chat",
        at,
        channel: "local",
        player: local[2],
        text: local[3],
      };
      if (local[1]) event.guildTag = local[1];
      return event;
    }
  }
  return undefined;
}

function bareAreaInfo(id: string): AreaInfo {
  return { id, name: id, category: "other" };
}

// ---------------------------------------------------------------------------
// Trade whisper templates
// ---------------------------------------------------------------------------

/**
 * One trade-site whisper template. Placeholders:
 *   item templates: {item} {price} {league} and, in `stash`, {tab} {left} {top};
 *   bulk templates: {want_amount} {want} {have_amount} {have} {league}.
 * The stash suffix is optional in the log (the buyer may trim it) and is
 * matched separately so languages that reorder it still parse.
 */
export interface TradeWhisperTemplate {
  language: string;
  kind: "item" | "bulk";
  text: string;
  /** Item templates only: the `(stash tab "…"; position: …)` suffix. */
  stash?: string;
  /** Only "en" was observed in a real Client.txt. */
  tested: boolean;
}

export const TRADE_WHISPER_TEMPLATES: readonly TradeWhisperTemplate[] = [
  // English — observed verbatim in the user's log.
  {
    language: "en",
    kind: "item",
    text: "Hi, I would like to buy your {item} listed for {price} in {league}",
    stash: '(stash tab "{tab}"; position: left {left}, top {top})',
    tested: true,
  },
  {
    language: "en",
    kind: "bulk",
    text: "Hi, I'd like to buy your {want_amount} {want} for my {have_amount} {have} in {league}",
    tested: true,
  },
  // Russian — untested, transcribed from the trade site.
  {
    language: "ru",
    kind: "item",
    text: "Здравствуйте, хочу купить у вас {item} за {price} в лиге {league}",
    stash: '(секция "{tab}"; позиция: {left} столбец, {top} ряд)',
    tested: false,
  },
  {
    language: "ru",
    kind: "bulk",
    text: "Здравствуйте, хочу купить у вас {want_amount} {want} за {have_amount} {have} в лиге {league}",
    tested: false,
  },
  // Portuguese (Brazil) — untested.
  {
    language: "pt",
    kind: "item",
    text: "Olá, eu gostaria de comprar o seu item {item} listado por {price} na {league}",
    stash: '(aba do baú: "{tab}"; posição: esquerda {left}, topo {top})',
    tested: false,
  },
  {
    language: "pt",
    kind: "bulk",
    text: "Olá, eu gostaria de comprar seu(s) {want_amount} {want} pelo(s) meu(s) {have_amount} {have} na {league}",
    tested: false,
  },
  // Korean — untested.
  {
    language: "ko",
    kind: "item",
    text: "안녕하세요, {league} 리그의 {price}(으)로 올려놓은 {item}(을)를 구매하고 싶습니다",
    stash: '(보관함 탭 "{tab}", 위치: 왼쪽 {left}, 상단 {top})',
    tested: false,
  },
  {
    language: "ko",
    kind: "bulk",
    text: "안녕하세요, {league} 리그에서 저의 {have_amount} {have}(으)로 당신의 {want_amount} {want}(을)를 구매하고 싶습니다",
    tested: false,
  },
  // German — untested.
  {
    language: "de",
    kind: "item",
    text: "Hi, ich möchte '{item}' zum angebotenen Preis von {price} in der {league}-Liga kaufen",
    stash: '(Truhenfach "{tab}"; Position: {left} von links, {top} von oben)',
    tested: false,
  },
  {
    language: "de",
    kind: "bulk",
    text: "Hi, ich möchte deine {want_amount} {want} für meine {have_amount} {have} in der {league}-Liga kaufen",
    tested: false,
  },
  // French — untested.
  {
    language: "fr",
    kind: "item",
    text: "Bonjour, je souhaiterais t'acheter {item} pour {price} dans la ligue {league}",
    stash: '(onglet de réserve "{tab}" ; {left}e en partant de la gauche, {top}e en partant du haut)',
    tested: false,
  },
  {
    language: "fr",
    kind: "bulk",
    text: "Bonjour, je voudrais acheter vos {want_amount} {want} contre mes {have_amount} {have} dans la ligue {league}",
    tested: false,
  },
  // Spanish — untested.
  {
    language: "es",
    kind: "item",
    text: "Hola, quisiera comprar tu {item} listado por {price} en {league}",
    stash: '(pestaña de alijo "{tab}"; posición: izquierda {left}, arriba {top})',
    tested: false,
  },
  {
    language: "es",
    kind: "bulk",
    text: "Hola, quisiera comprar tus {want_amount} {want} por mis {have_amount} {have} en {league}",
    tested: false,
  },
  // Thai — untested.
  {
    language: "th",
    kind: "item",
    text: "สวัสดี, เราต้องการที่จะชื้อของคุณ {item} ในราคา {price} ใน {league}",
    stash: '(stash tab "{tab}"; ตำแหน่ง: ซ้าย {left}, บน {top})',
    tested: false,
  },
  {
    language: "th",
    kind: "bulk",
    text: "สวัสดี, เราต้องการที่จะชื้อของคุณ {want_amount} {want} สำหรับ {have_amount} {have} ของเราใน {league}",
    tested: false,
  },
  // Japanese — untested.
  {
    language: "ja",
    kind: "item",
    text: "こんにちは、{league} リーグで {price} で売っている {item} を買いたいです",
    stash: '(スタッシュタブ "{tab}"; 位置: 左 {left}, 上 {top})',
    tested: false,
  },
  {
    language: "ja",
    kind: "bulk",
    text: "こんにちは、{league} リーグで私の {have_amount} {have} で {want_amount} {want} を買いたいです",
    tested: false,
  },
  // Simplified Chinese — untested.
  {
    language: "zh-Hans",
    kind: "item",
    text: "您好，我想购买您在 {league} 联盟以 {price} 出售的 {item}",
    stash: '(仓库页 "{tab}"; 位置: 左 {left}, 上 {top})',
    tested: false,
  },
  {
    language: "zh-Hans",
    kind: "bulk",
    text: "您好，我想用我的 {have_amount} {have} 购买您的 {want_amount} {want}，在 {league} 联盟",
    tested: false,
  },
  // Traditional Chinese — untested.
  {
    language: "zh-Hant",
    kind: "item",
    text: "你好，我想購買 {item} 標價 {price} 在 {league}",
    stash: '(倉庫頁 "{tab}"; 位置: 左 {left}, 上 {top})',
    tested: false,
  },
  {
    language: "zh-Hant",
    kind: "bulk",
    text: "你好，我想用我的 {have_amount} {have} 購買你的 {want_amount} {want}，在 {league}",
    tested: false,
  },
];

const NUMBER = String.raw`\d+(?:[.,]\d+)?`;
const PLACEHOLDER_PATTERNS: Record<string, string> = {
  item: "(?<item>.+?)",
  price: `(?<amount>${NUMBER}) (?<currency>.+?)`,
  league: "(?<league>.+?)",
  tab: '(?<tab>[^"]*)',
  left: String.raw`(?<left>\d+)`,
  top: String.raw`(?<top>\d+)`,
  want_amount: `(?<wantAmount>${NUMBER})`,
  want: "(?<want>.+?)",
  have_amount: `(?<haveAmount>${NUMBER})`,
  have: "(?<have>.+?)",
};

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileTemplateText(text: string): string {
  return text
    .split(/(\{[a-z_]+\})/)
    .map((part) => {
      const placeholder = /^\{([a-z_]+)\}$/.exec(part);
      if (!placeholder) return escapeRegex(part);
      const pattern = PLACEHOLDER_PATTERNS[placeholder[1]];
      if (!pattern) throw new Error(`unknown whisper placeholder {${placeholder[1]}}`);
      return pattern;
    })
    .join("");
}

interface CompiledTemplate {
  template: TradeWhisperTemplate;
  regex: RegExp;
}

let compiled: CompiledTemplate[] | undefined;

function compiledTemplates(): CompiledTemplate[] {
  if (!compiled) {
    // Bulk first: some languages (ru) share the item wording, and only the
    // bulk shape demands a leading quantity, so it is the stricter match.
    const ordered = [...TRADE_WHISPER_TEMPLATES].sort((a, b) =>
      a.kind === b.kind ? 0 : a.kind === "bulk" ? -1 : 1,
    );
    compiled = ordered.map((template) => {
      const body = compileTemplateText(template.text);
      const stash = template.stash ? `(?: ${compileTemplateText(template.stash)})?` : "";
      // Trailing punctuation: the bulk template ends with "." on the trade site.
      return { template, regex: new RegExp(`^${body}${stash}[.。]?\\s*$`, "u") };
    });
  }
  return compiled;
}

function parseAmount(text: string): number {
  return Number(text.replace(",", "."));
}

/**
 * Splits "Ghoul Lash, Long Belt" into name + base. Base types never contain
 * commas, so the LAST comma is the split; a plain base ("Long Belt") is both.
 */
export function splitWhisperItemName(item: string): { itemName: string; baseType: string } {
  const at = item.lastIndexOf(", ");
  if (at < 0) return { itemName: item, baseType: item };
  return { itemName: item.slice(0, at), baseType: item.slice(at + 2) };
}

/** Matches the text against every language template; undefined for plain whispers. */
export function parseTradeWhisper(text: string): TradeWhisper | undefined {
  const trimmed = text.trim();
  for (const { template, regex } of compiledTemplates()) {
    const match = regex.exec(trimmed);
    if (!match?.groups) continue;
    const groups = match.groups;
    if (template.kind === "item") {
      const { itemName, baseType } = splitWhisperItemName(groups.item);
      const whisper: TradeWhisper = {
        kind: "item",
        language: template.language,
        itemName,
        baseType,
        price: { amount: parseAmount(groups.amount), currency: groups.currency },
        league: groups.league,
        raw: text,
      };
      if (groups.tab !== undefined) whisper.stashTab = groups.tab;
      if (groups.left !== undefined && groups.top !== undefined) {
        whisper.position = { left: Number(groups.left), top: Number(groups.top) };
      }
      return whisper;
    }
    return {
      kind: "bulk",
      language: template.language,
      itemName: groups.want,
      quantity: parseAmount(groups.wantAmount),
      price: { amount: parseAmount(groups.haveAmount), currency: groups.have },
      league: groups.league,
      raw: text,
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** `…/logs/Client.txt` (or the Korean client's `KakaoClient.txt`), any casing. */
export function isLikelyClientLogPath(path: string): boolean {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  return /^(kakao)?client\.txt$/i.test(base);
}
