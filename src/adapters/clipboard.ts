import { clipboard } from "electron";

export async function readClipboardText(): Promise<string> {
  return clipboard.readText();
}
