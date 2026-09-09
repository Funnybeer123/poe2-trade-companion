interface RendererEventWindow {
  isDestroyed(): boolean;
  readonly webContents: {
    isDestroyed(): boolean;
    send(channel: string, ...args: unknown[]): void;
  };
}

/** Service shutdown events can outlive the renderer they were created for. */
export function sendRendererEvent(window: RendererEventWindow | undefined, channel: string, ...args: unknown[]): void {
  if (!window || window.isDestroyed()) return;
  const contents = window.webContents;
  if (!contents.isDestroyed()) contents.send(channel, ...args);
}
