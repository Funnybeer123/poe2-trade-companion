import { createRequire } from "node:module";
import { basename } from "node:path";
import { PerceptionUnavailableError } from "./unavailable.js";

interface KoffiLib {
  func(declaration: string): (...args: never[]) => unknown;
}

interface KoffiModule {
  load(name: string): KoffiLib;
}

export interface ProcessLibraryLoader {
  platform: NodeJS.Platform;
  loadKoffi(): KoffiModule;
}

export interface ForegroundProcessInfo {
  pid?: number;
  name?: string;
  title?: string;
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const TITLE_CHARS = 512;
const IMAGE_CHARS = 32768;

function defaultLoadKoffi(): KoffiModule {
  const require = createRequire(import.meta.url);
  return require("koffi") as KoffiModule;
}

export function defaultProcessLoader(): ProcessLibraryLoader {
  return {
    platform: process.platform,
    loadKoffi: defaultLoadKoffi,
  };
}

type GetForegroundWindowFn = () => unknown;
type GetWindowTextFn = (hwnd: unknown, buffer: Buffer, maxCount: number) => number;
type GetWindowThreadProcessIdFn = (hwnd: unknown, pidOut: Buffer) => number;
type OpenProcessFn = (access: number, inherit: number, pid: number) => unknown;
type QueryFullProcessImageNameFn = (
  handle: unknown,
  flags: number,
  buffer: Buffer,
  sizeOut: Buffer,
) => number;
type CloseHandleFn = (handle: unknown) => number;

function readWideString(buffer: Buffer, charCount: number): string {
  const end = Math.max(0, charCount) * 2;
  const text = buffer.subarray(0, end).toString("utf16le");
  const nul = text.indexOf("\0");
  return nul === -1 ? text : text.slice(0, nul);
}

/**
 * Win32 foreground window / process query via koffi.
 * Window-metadata only — this module must not send input.
 */
export class Win32ProcessQuery {
  readonly #getForegroundWindow: GetForegroundWindowFn;
  readonly #getWindowText: GetWindowTextFn;
  readonly #getWindowThreadProcessId: GetWindowThreadProcessIdFn;
  readonly #openProcess: OpenProcessFn;
  readonly #queryFullProcessImageName: QueryFullProcessImageNameFn;
  readonly #closeHandle: CloseHandleFn;

  constructor(loader: ProcessLibraryLoader = defaultProcessLoader()) {
    if (loader.platform !== "win32") {
      throw new PerceptionUnavailableError(
        `Win32 process query requires win32 (got ${loader.platform})`,
      );
    }
    let koffi: KoffiModule;
    try {
      koffi = loader.loadKoffi();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new PerceptionUnavailableError(`koffi could not load (${detail})`);
    }
    try {
      const user32 = koffi.load("user32.dll");
      const kernel32 = koffi.load("kernel32.dll");
      this.#getForegroundWindow = user32.func(
        "void * __stdcall GetForegroundWindow()",
      ) as GetForegroundWindowFn;
      this.#getWindowText = user32.func(
        "int32 __stdcall GetWindowTextW(void *hWnd, void *lpString, int32 nMaxCount)",
      ) as GetWindowTextFn;
      this.#getWindowThreadProcessId = user32.func(
        "uint32 __stdcall GetWindowThreadProcessId(void *hWnd, void *lpdwProcessId)",
      ) as GetWindowThreadProcessIdFn;
      this.#openProcess = kernel32.func(
        "void * __stdcall OpenProcess(uint32 dwDesiredAccess, int32 bInheritHandle, uint32 dwProcessId)",
      ) as OpenProcessFn;
      this.#queryFullProcessImageName = kernel32.func(
        "int32 __stdcall QueryFullProcessImageNameW(void *hProcess, uint32 dwFlags, void *lpExeName, void *lpdwSize)",
      ) as QueryFullProcessImageNameFn;
      this.#closeHandle = kernel32.func("int32 __stdcall CloseHandle(void *hObject)") as CloseHandleFn;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new PerceptionUnavailableError(`Win32 bind failed (${detail})`);
    }
  }

  query(): ForegroundProcessInfo {
    const hwnd = this.#getForegroundWindow();
    if (hwnd === null || hwnd === undefined || hwnd === 0) {
      return {};
    }

    const titleBuf = Buffer.alloc(TITLE_CHARS * 2);
    const titleChars = this.#getWindowText(hwnd, titleBuf, TITLE_CHARS);
    const title = titleChars > 0 ? readWideString(titleBuf, titleChars) : undefined;

    const pidBuf = Buffer.alloc(4);
    this.#getWindowThreadProcessId(hwnd, pidBuf);
    const pid = pidBuf.readUInt32LE(0);

    let name: string | undefined;
    if (pid > 0) {
      const handle = this.#openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
      if (handle) {
        try {
          const imageBuf = Buffer.alloc(IMAGE_CHARS * 2);
          const sizeBuf = Buffer.alloc(4);
          sizeBuf.writeUInt32LE(IMAGE_CHARS, 0);
          const ok = this.#queryFullProcessImageName(handle, 0, imageBuf, sizeBuf);
          if (ok) {
            const chars = sizeBuf.readUInt32LE(0);
            const imagePath = readWideString(imageBuf, chars);
            if (imagePath.length > 0) {
              name = basename(imagePath);
            }
          }
        } finally {
          this.#closeHandle(handle);
        }
      }
    }

    return {
      pid: pid > 0 ? pid : undefined,
      name,
      title,
    };
  }
}

export function queryForegroundProcess(
  loader: ProcessLibraryLoader = defaultProcessLoader(),
): ForegroundProcessInfo {
  return new Win32ProcessQuery(loader).query();
}
