import { describe, expect, it } from "vitest";
import { parseGameSettingsIni, parseIniSections } from "../src/core/gameSettingsFile.js";

const SAMPLE = [
  "[GENERAL]",
  "version=2",
  "",
  "[DISPLAY]",
  "resolution_width=2560",
  "resolution_height=1440",
  "fullscreen=false",
  "borderless_windowed_fullscreen=true",
  "; comment",
  "[ACTION_KEYS]",
  "chat=13",
  "move=32 0",
  "stash_search=70",
].join("\r\n");

describe("parseGameSettingsIni", () => {
  it("reads resolution, window mode and the chat / search keys; no language key → undefined", () => {
    expect(parseGameSettingsIni(SAMPLE)).toEqual({
      resolution: { width: 2560, height: 1440 },
      fullscreen: false,
      borderlessWindowed: true,
      chatKey: 13,
      searchKey: 70,
    });
  });

  it("maps a language key to a code and keeps unknown values verbatim", () => {
    expect(parseGameSettingsIni(`${SAMPLE}\r\n[LANGUAGE]\r\nlanguage=Russian\r\n`).language).toBe("ru");
    expect(parseGameSettingsIni("[LANGUAGE]\nlanguage=Traditional Chinese").language).toBe("zh-Hant");
    expect(parseGameSettingsIni("[LANGUAGE]\nlanguage=klingon").language).toBe("klingon");
    expect(parseGameSettingsIni("[LANGUAGE]\nlanguage=").language).toBeUndefined();
  });

  it("tolerates a BOM, LF endings, numeric booleans and multi-number key values", () => {
    const text = "﻿[DISPLAY]\nresolution_width=1920\nresolution_height=1080\nfullscreen=1\n[ACTION_KEYS]\nchat=13 0\n";
    expect(parseGameSettingsIni(text)).toEqual({
      resolution: { width: 1920, height: 1080 },
      fullscreen: true,
      chatKey: 13,
    });
  });

  it("returns an empty object for garbage or partial input", () => {
    expect(parseGameSettingsIni("")).toEqual({});
    expect(parseGameSettingsIni("not an ini at all")).toEqual({});
    expect(parseGameSettingsIni("[DISPLAY]\nresolution_width=abc\nresolution_height=1080\nfullscreen=maybe")).toEqual({});
  });

  it("parseIniSections lowercases keys, uppercases sections, ignores comments", () => {
    expect(parseIniSections("[Display]\nResolution_Width = 10\n# c\n;c\nnoequals\n=novalue")).toEqual({
      DISPLAY: { resolution_width: "10" },
    });
  });
});
