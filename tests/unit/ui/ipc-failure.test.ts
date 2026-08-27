import { withIpcError } from "@poe2tc/core";
import { describe, expect, it } from "vitest";

describe("IPC failure handling", () => {
  it("surfaces an error and does not rearm automation", () => {
    const disarmed = withIpcError(false, new Error("overlay-bridge-down"));
    expect(disarmed.armed).toBe(false);
    expect(disarmed.ipcError.code).toBe("ipc-failure");
    expect(disarmed.ipcError.message).toBe("overlay-bridge-down");

    const stayedArmed = withIpcError(true, new Error("timeout"));
    expect(stayedArmed.armed).toBe(true);
    expect(stayedArmed.ipcError.message).toBe("timeout");
  });
});
