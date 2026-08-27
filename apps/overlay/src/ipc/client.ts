import { toIpcError, withIpcError, type IpcErrorDto, type Poe2tcPreloadApi } from "@poe2tc/core/operator";
import { installBrowserMock } from "./mock.js";

export { toIpcError, withIpcError };
export type { IpcErrorDto };

export function resolvePreloadApi(): Poe2tcPreloadApi {
  return window.poe2tc ?? installBrowserMock();
}
