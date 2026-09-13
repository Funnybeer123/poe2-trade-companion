import { clipboard } from "electron";

export function readClipboardText(): Promise<string> {
  return clipboard.readText();
}
