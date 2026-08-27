import type { IpcErrorDto } from "./ipcTypes.js";

export function toIpcError(error: unknown): IpcErrorDto {
  if (error instanceof Error) {
    return { code: "ipc-failure", message: error.message };
  }
  return { code: "ipc-failure", message: String(error) };
}

/**
 * IPC failures show an error panel. They do not rearm automation.
 */
export function withIpcError(
  previousArmed: boolean,
  error: unknown,
): { armed: boolean; ipcError: IpcErrorDto } {
  return {
    armed: previousArmed,
    ipcError: toIpcError(error),
  };
}
