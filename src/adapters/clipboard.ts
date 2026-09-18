import { clipboard } from "electron";

export function readClipboardText(): string {
  return clipboard.readText();
}
