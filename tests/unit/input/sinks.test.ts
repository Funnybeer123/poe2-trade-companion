import {
  createCapabilities,
  createInputSink,
  ForbiddenInputSink,
  NoopInputSink,
  PUBLIC_COMPANION_FORBIDDEN_REASON,
  RecordingInputSink,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";

const click = { type: "mouse-click" as const, x: 10, y: 20, button: "left" as const };

describe("Input sinks", () => {
  it("ForbiddenInputSink always reports public-companion-forbids-native-input", async () => {
    const sink = new ForbiddenInputSink();
    const result = await sink.execute(click);
    expect(sink.kind).toBe("forbidden");
    expect(result.accepted).toBe(false);
    expect(result.executed).toBe(false);
    expect(result.blockedReason).toBe(PUBLIC_COMPANION_FORBIDDEN_REASON);
    expect(result.blockedReason).toBe("public-companion-forbids-native-input");
  });

  it("NoopInputSink records intended actions and never executes", async () => {
    const sink = new NoopInputSink();
    const result = await sink.execute(click);
    expect(sink.kind).toBe("noop");
    expect(result.executed).toBe(false);
    expect(result.accepted).toBe(true);
    expect(sink.recorded).toEqual([click]);
  });

  it("RecordingInputSink wraps another sink and appends actions", async () => {
    const inner = new NoopInputSink();
    const recording = new RecordingInputSink(inner);
    await recording.execute(click);
    expect(recording.kind).toBe("recording");
    expect(recording.actions).toEqual([click]);
    expect(inner.recorded).toEqual([click]);
  });

  it("createInputSink returns ForbiddenInputSink unless native input is eligible", () => {
    const publicSink = createInputSink(createCapabilities("public-companion"));
    expect(publicSink).toBeInstanceOf(ForbiddenInputSink);
    const qaSink = createInputSink(createCapabilities("authorized-qa"));
    expect(qaSink).toBeInstanceOf(NoopInputSink);
  });
});
