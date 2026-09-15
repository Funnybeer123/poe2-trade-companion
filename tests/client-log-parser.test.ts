import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { areaInfo } from "../src/core/areaCatalog.js";
import {
  isLikelyClientLogPath,
  parseClientLogLine,
  parseClientLogPrefix,
  parseTradeWhisper,
  splitWhisperItemName,
  TRADE_WHISPER_TEMPLATES,
  type ClientLogEvent,
} from "../src/core/clientLog.js";

const P = "2026/09/11 20:52:15 40206281 2caa229f [INFO Client 23032] ";
const D = "2026/09/11 20:52:15 40206281 2caa229f [DEBUG Client 23032] ";
const AT = new Date(2026, 8, 11, 20, 52, 15).toISOString();

function parse(rest: string, prefix = P): ClientLogEvent | undefined {
  return parseClientLogLine(prefix + rest, areaInfo);
}

describe("client log line prefix", () => {
  it("parses the timestamp in the local timezone and keeps the rest", () => {
    const prefix = parseClientLogPrefix(`${P}: Trade accepted.`);
    expect(prefix).toEqual({ at: AT, level: "INFO", pid: 23032, rest: ": Trade accepted." });
  });

  it("tolerates a trailing carriage return and rejects non-log lines", () => {
    expect(parseClientLogPrefix(`${P}: Trade accepted.\r`)?.rest).toBe(": Trade accepted.");
    expect(parseClientLogPrefix("")).toBeUndefined();
    expect(parseClientLogPrefix("not a log line")).toBeUndefined();
    expect(parseClientLogPrefix("2026/13/45 99:99:99 1 x [INFO Client 1] nope")).toBeUndefined();
  });
});

describe("system messages", () => {
  it("area generation (DEBUG) carries the monster level, seed and catalogue info", () => {
    expect(parse('Generating level 79 area "MapSunTemple" with seed 2600198359', D)).toEqual({
      kind: "area",
      at: AT,
      areaId: "MapSunTemple",
      level: 79,
      seed: 2600198359,
      info: { id: "MapSunTemple", name: "Sun Temple", category: "map" },
    });
    const hideout = parse('Generating level 65 area "HideoutBeaconOfSalvation" with seed 1', D);
    expect(hideout?.kind).toBe("area");
    expect(hideout && hideout.kind === "area" && hideout.info.category).toBe("hideout");
  });

  it("ignores other DEBUG chatter", () => {
    expect(parse("Tile hash: 2316889541", D)).toBeUndefined();
    expect(parse(": Trade accepted.", D)).toBeUndefined();
  });

  it("instance server (trailing space kept out of the address)", () => {
    expect(parse("Connecting to instance server at 64.87.48.12:21360 ")).toEqual({
      kind: "instance",
      at: AT,
      address: "64.87.48.12:21360",
    });
  });

  it("level-up with the ascendancy as class name", () => {
    expect(parse(": Himbothlice (Disciple of Varashta) is now level 88")).toEqual({
      kind: "level-up",
      at: AT,
      character: "Himbothlice",
      className: "Disciple of Varashta",
      level: 88,
    });
    expect(parse(": Newbie (Witch) is now level 2")).toMatchObject({ className: "Witch", level: 2 });
  });

  it("death, trade result, area join/leave, AFK, party, player-not-found", () => {
    expect(parse(": HarrisonBot has been slain.")).toEqual({ kind: "death", at: AT, character: "HarrisonBot" });
    expect(parse(": Trade accepted.")).toEqual({ kind: "trade", at: AT, result: "accepted" });
    expect(parse(": Trade cancelled.")).toEqual({ kind: "trade", at: AT, result: "cancelled" });
    expect(parse(": Buyer has joined the area.")).toEqual({ kind: "area-join", at: AT, player: "Buyer", joined: true });
    expect(parse(": Buyer has left the area.")).toEqual({ kind: "area-join", at: AT, player: "Buyer", joined: false });
    expect(parse(': AFK mode is now ON. Autoreply "This player is AFK."')).toEqual({
      kind: "afk",
      at: AT,
      on: true,
      autoreply: "This player is AFK.",
    });
    expect(parse(": AFK mode is now ON.")).toEqual({ kind: "afk", at: AT, on: true, autoreply: undefined });
    expect(parse(": AFK mode is now OFF.")).toEqual({ kind: "afk", at: AT, on: false });
    expect(parse(": Mate has joined the party.")).toEqual({ kind: "party", at: AT, player: "Mate", action: "joined" });
    expect(parse(": Mate has left the party.")).toEqual({ kind: "party", at: AT, player: "Mate", action: "left" });
    expect(parse(": Mate has been kicked from the party.")).toEqual({
      kind: "party",
      at: AT,
      player: "Mate",
      action: "kicked",
    });
    expect(parse(": Player not found.")).toEqual({ kind: "player-not-found", at: AT });
    expect(parse(": That player is not online.")).toEqual({ kind: "player-not-found", at: AT });
    expect(parse(": Something we do not know.")).toBeUndefined();
  });
});

describe("whispers and chat channels", () => {
  it("direction comes from the @From/@To token right after the bracket", () => {
    expect(parse("@From Buyer: ty")).toEqual({ kind: "whisper", at: AT, direction: "in", player: "Buyer", text: "ty" });
    expect(parse("@To Buyer: np, gl")).toEqual({ kind: "whisper", at: AT, direction: "out", player: "Buyer", text: "np, gl" });
  });

  it("keeps the guild tag separate from the character name", () => {
    expect(parse("@From <TAG> Buyer: hi")).toEqual({
      kind: "whisper",
      at: AT,
      direction: "in",
      player: "Buyer",
      text: "hi",
      guildTag: "TAG",
    });
  });

  it("a plain whisper has no trade payload", () => {
    const event = parse("@From Buyer: are you there?");
    expect(event?.kind).toBe("whisper");
    expect((event as { trade?: unknown }).trade).toBeUndefined();
    expect(Object.keys(event ?? {})).not.toContain("trade");
  });

  it("global chat containing '@' or a whisper-looking body is still chat", () => {
    expect(parse("#Shouter: wts mirror @ 500 div pm me")).toEqual({
      kind: "chat",
      at: AT,
      channel: "global",
      player: "Shouter",
      text: "wts mirror @ 500 div pm me",
    });
    expect(parse("#Troll: @From Bob: Hi, I would like to buy your X listed for 1 exalted in L")).toMatchObject({
      kind: "chat",
      channel: "global",
      player: "Troll",
    });
  });

  it("maps every channel prefix, guild tags included, plus local chat", () => {
    expect(parse("$Trader: wtb ex 1:1")).toMatchObject({ kind: "chat", channel: "trade", player: "Trader", text: "wtb ex 1:1" });
    expect(parse("&<FAKE> Guildie: anyone on?")).toMatchObject({ channel: "guild", player: "Guildie", guildTag: "FAKE" });
    expect(parse("%Partymate: go go")).toMatchObject({ channel: "party", player: "Partymate" });
    expect(parse("Localtalker: hello there")).toMatchObject({ channel: "local", player: "Localtalker", text: "hello there" });
    // Engine lines with a colon are not local chat (multi-token "name").
    expect(parse("Tile hash: 2316889541")).toBeUndefined();
    expect(parse("Send patching protocol version 2")).toBeUndefined();
  });
});

describe("trade whispers (English, observed)", () => {
  it("item whisper with name + base, league with spaces, ~price tab and position", () => {
    const event = parse(
      '@From Buyer: Hi, I would like to buy your Ghoul Lash, Long Belt listed for 1 exalted in Forbidden Rites (stash tab "~price 1 exalted"; position: left 10, top 10)',
    );
    expect(event?.kind).toBe("whisper");
    expect(event && event.kind === "whisper" ? event.trade : undefined).toEqual({
      kind: "item",
      language: "en",
      itemName: "Ghoul Lash",
      baseType: "Long Belt",
      price: { amount: 1, currency: "exalted" },
      league: "Forbidden Rites",
      stashTab: "~price 1 exalted",
      position: { left: 10, top: 10 },
      raw: 'Hi, I would like to buy your Ghoul Lash, Long Belt listed for 1 exalted in Forbidden Rites (stash tab "~price 1 exalted"; position: left 10, top 10)',
    });
  });

  it("outgoing whisper, ~b/o tab, four-word league", () => {
    const event = parse(
      '@To Seller: Hi, I would like to buy your The Grand Project, Precursor Tablet listed for 30 exalted in Second Wind Fate of the Vaal (stash tab "~b/o 30 exalted"; position: left 1, top 21)',
    );
    expect(event && event.kind === "whisper" ? { direction: event.direction, trade: event.trade } : undefined).toMatchObject({
      direction: "out",
      trade: {
        itemName: "The Grand Project",
        baseType: "Precursor Tablet",
        price: { amount: 30, currency: "exalted" },
        league: "Second Wind Fate of the Vaal",
        stashTab: "~b/o 30 exalted",
        position: { left: 1, top: 21 },
      },
    });
  });

  it("bulk exchange whisper (real shape, no trailing period) and the trade-site shape with one", () => {
    const expected = {
      kind: "bulk",
      language: "en",
      itemName: "Preserved Cranium",
      quantity: 2,
      price: { amount: 20, currency: "Exalted Orb" },
      league: "Fate of the Vaal",
    };
    expect(parseTradeWhisper("Hi, I'd like to buy your 2 Preserved Cranium for my 20 Exalted Orb in Fate of the Vaal")).toMatchObject(expected);
    expect(parseTradeWhisper("Hi, I'd like to buy your 20 Exalted Orb for my 1 Divine Orb in Standard.")).toMatchObject({
      kind: "bulk",
      itemName: "Exalted Orb",
      quantity: 20,
      price: { amount: 1, currency: "Divine Orb" },
      league: "Standard",
    });
  });

  it("normal items have base as name; names with commas split at the last comma; decimals parse", () => {
    expect(splitWhisperItemName("Long Belt")).toEqual({ itemName: "Long Belt", baseType: "Long Belt" });
    expect(splitWhisperItemName("Shavronne's Wrappings, Twist, Occultist's Vestment")).toEqual({
      itemName: "Shavronne's Wrappings, Twist",
      baseType: "Occultist's Vestment",
    });
    const trade = parseTradeWhisper(
      "Hi, I would like to buy your Doedre's Elixir, Greater Mana Flask listed for 1.5 divine in Standard",
    );
    expect(trade).toMatchObject({
      itemName: "Doedre's Elixir",
      baseType: "Greater Mana Flask",
      price: { amount: 1.5, currency: "divine" },
      league: "Standard",
    });
    expect(trade?.stashTab).toBeUndefined();
    expect(trade?.position).toBeUndefined();
    expect(parseTradeWhisper("Hi, I would like to buy your Long Belt listed for 5 chaos in Standard")).toMatchObject({
      itemName: "Long Belt",
      baseType: "Long Belt",
    });
  });

  it("returns undefined for free text", () => {
    expect(parseTradeWhisper("hi, still selling?")).toBeUndefined();
    expect(parseTradeWhisper("")).toBeUndefined();
  });
});

describe("trade whisper templates in every language", () => {
  const sample: Record<string, string> = {
    item: "Ghoul Lash, Long Belt",
    price: "3 exalted",
    league: "Forbidden Rites",
    tab: "~price 3 exalted",
    left: "4",
    top: "7",
    want_amount: "20",
    want: "Exalted Orb",
    have_amount: "1",
    have: "Divine Orb",
  };
  const fill = (text: string) => text.replace(/\{([a-z_]+)\}/g, (_, key: string) => sample[key]);

  it("covers all ten languages with both an item and a bulk template", () => {
    const languages = new Set(TRADE_WHISPER_TEMPLATES.map((t) => t.language));
    expect([...languages].sort()).toEqual(["de", "en", "es", "fr", "ja", "ko", "pt", "ru", "th", "zh-Hans", "zh-Hant"]);
    for (const language of languages) {
      const kinds = TRADE_WHISPER_TEMPLATES.filter((t) => t.language === language).map((t) => t.kind);
      expect(kinds.sort(), language).toEqual(["bulk", "item"]);
    }
    expect(TRADE_WHISPER_TEMPLATES.filter((t) => t.tested).every((t) => t.language === "en")).toBe(true);
  });

  for (const template of TRADE_WHISPER_TEMPLATES) {
    it(`${template.language} ${template.kind} round-trips${template.tested ? "" : " (template untested in-game)"}`, () => {
      if (template.kind === "item") {
        const withStash = `${fill(template.text)} ${fill(template.stash!)}`;
        expect(parseTradeWhisper(withStash)).toMatchObject({
          kind: "item",
          language: template.language,
          itemName: "Ghoul Lash",
          baseType: "Long Belt",
          price: { amount: 3, currency: "exalted" },
          league: "Forbidden Rites",
          stashTab: "~price 3 exalted",
          position: { left: 4, top: 7 },
        });
        const bare = parseTradeWhisper(fill(template.text));
        expect(bare).toMatchObject({ kind: "item", language: template.language, league: "Forbidden Rites" });
        expect(bare?.position).toBeUndefined();
      } else {
        expect(parseTradeWhisper(`${fill(template.text)}.`)).toMatchObject({
          kind: "bulk",
          language: template.language,
          itemName: "Exalted Orb",
          quantity: 20,
          price: { amount: 1, currency: "Divine Orb" },
          league: "Forbidden Rites",
        });
      }
    });
  }
});

describe("fixture and paths", () => {
  it("parses every line of the redacted English fixture into the expected kinds", () => {
    const text = readFileSync(path.join(process.cwd(), "fixtures", "client-log", "sample-en.txt"), "utf8");
    const kinds = text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => parseClientLogLine(line, areaInfo)?.kind ?? "-");
    expect(kinds).toEqual([
      "instance",
      "area",
      "-",
      "-",
      "area",
      "level-up",
      "death",
      "trade",
      "trade",
      "area-join",
      "area-join",
      "afk",
      "afk",
      "whisper",
      "whisper",
      "whisper",
      "whisper",
      "whisper",
      "chat",
      "chat",
      "chat",
      "chat",
      "chat",
      "party",
      "party",
      "player-not-found",
    ]);
  });

  it("recognises Client.txt paths", () => {
    expect(isLikelyClientLogPath("C:\\Program Files (x86)\\Steam\\steamapps\\common\\Path of Exile 2\\logs\\Client.txt")).toBe(true);
    expect(isLikelyClientLogPath("/games/poe2/logs/client.TXT")).toBe(true);
    expect(isLikelyClientLogPath("D:\\PoE2\\logs\\KakaoClient.txt")).toBe(true);
    expect(isLikelyClientLogPath("C:\\logs\\Client.log")).toBe(false);
    expect(isLikelyClientLogPath("")).toBe(false);
  });
});
