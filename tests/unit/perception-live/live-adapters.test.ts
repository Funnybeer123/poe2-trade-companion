import { FrozenClock } from "@poe2tc/core";
import {
  ClipboardSource,
  createElectronClipboardReader,
  ElectronFrameSource,
  LivePerceptionAdapter,
  PerceptionUnavailableError,
  Win32ProcessQuery,
} from "@poe2tc/perception-live";
import { describe, expect, it } from "vitest";

describe("perception-live adapters", () => {
  it("throws perception-unavailable when constructing Win32ProcessQuery off Windows", () => {
    expect(
      () =>
        new Win32ProcessQuery({
          platform: "linux",
          loadKoffi: () => {
            throw new Error("should-not-load");
          },
        }),
    ).toThrow(PerceptionUnavailableError);
  });

  it("captures a frame from an injected desktopCapturer", async () => {
    const source = new ElectronFrameSource({
      clock: new FrozenClock(42_000),
      sourceNameIncludes: ["Path of Exile 2"],
      capturer: {
        async getSources() {
          return [
            {
              id: "window:1",
              name: "Path of Exile 2",
              thumbnail: {
                getSize: () => ({ width: 2, height: 2 }),
                toBitmap: () => {
                  const bgra = new Uint8Array(16);
                  bgra.set([10, 20, 30, 255], 0);
                  return bgra;
                },
              },
            },
          ];
        },
      },
    });
    const frame = await source.nextFrame();
    expect(frame).not.toBeNull();
    expect(frame?.tickId).toBe(1);
    expect(frame?.capturedAtMs).toBe(42_000);
    expect(frame?.width).toBe(2);
    expect(frame?.height).toBe(2);
    expect(frame?.pixels?.[0]).toBe(30);
    expect(frame?.pixels?.[1]).toBe(20);
    expect(frame?.pixels?.[2]).toBe(10);
  });

  it("reads clipboard text through the injected reader only", () => {
    const clipboard = createElectronClipboardReader({ readText: () => "Rarity: Unique" });
    const source = new ClipboardSource(clipboard);
    expect(source.readText()).toBe("Rarity: Unique");
  });

  it("maps analyze errors to unknown UI instead of throwing", async () => {
    const adapter = new LivePerceptionAdapter(() => {
      throw new Error("no-hwnd");
    });
    const frame = await adapter.analyze({
      tickId: 3,
      capturedAtMs: 1_000,
      width: 8,
      height: 8,
    });
    expect(frame.ui?.value.kind).toBe("unknown");
    expect(frame.ui?.confidence).toBe(0);
    expect(frame.process?.value.allowlisted).toBe(false);
  });

  it("attaches queried process metadata on success", async () => {
    const adapter = new LivePerceptionAdapter(() => ({
      pid: 11,
      name: "PathOfExile.exe",
      title: "Path of Exile 2",
    }));
    const frame = await adapter.analyze({
      tickId: 1,
      capturedAtMs: 5_000,
      width: 64,
      height: 64,
    });
    expect(frame.process?.value.name).toBe("PathOfExile.exe");
    expect(frame.process?.value.title).toBe("Path of Exile 2");
    expect(frame.process?.value.allowlisted).toBe(false);
  });
});
