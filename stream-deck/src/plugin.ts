import streamDeck, { SingletonAction, action } from "@elgato/streamdeck";
import { DECK_ACTIONS, type DeckActionId } from "../../src/shared/deckActions.js";
import { AppClient } from "./client.js";
const client = new AppClient();
const errors = new Map<string, { reason: string; until: number }>();
const instances: CompanionAction[] = [];
let inspectorCommand: DeckActionId | undefined;
const uuid = (id: string) => `com.poe2companion.deck.${id.replaceAll(".", "-").toLowerCase()}`;
class CompanionAction extends SingletonAction {
  private visible = new Map<string, any>();
  private last = new Map<string, string>();
  private lastPress = new Map<string, number>();
  constructor(readonly command: DeckActionId, readonly label: string, readonly detail: string) { super(); }
  async onWillAppear(ev: any) { this.visible.set(ev.action.id, ev.action); await this.render(); }
  onWillDisappear(ev: any) { this.visible.delete(ev.action.id); this.last.delete(ev.action.id); }
  async onPropertyInspectorDidAppear() { inspectorCommand = this.command; await this.inspect(); }
  onPropertyInspectorDidDisappear() { if (inspectorCommand === this.command) inspectorCommand = undefined; }
  async inspect() {
    await streamDeck.ui.sendToPropertyInspector({ command: this.command, detail: errors.get(this.command)?.reason ?? client.status?.buttons[this.command]?.detail ?? "App disconnected", dryRun: client.status?.dryRun ?? null });
  }
  async onKeyDown(ev: any) {
    const now = Date.now();
    if (now - (this.lastPress.get(ev.action.id) ?? 0) < 500) return;
    this.lastPress.set(ev.action.id, now);
    const ack = await client.press(this.command);
    if (!ack.ok) { errors.set(this.command, { reason: ack.reason, until: Date.now() + 6000 }); await ev.action.showAlert(); }
    else { errors.delete(this.command); await ev.action.showOk(); }
    await client.poll(); await this.render(); await this.inspect();
  }
  async render() {
    const error = errors.get(this.command);
    if (error && error.until < Date.now()) errors.delete(this.command);
    const button = client.status?.buttons[this.command];
    const state = !button ? "disconnected" : errors.has(this.command) ? "error" : button.state;
    const title = button?.count !== undefined && state === "active" ? String(button.count) : "";
    const key = `${state}:${title}`;
    for (const [id, keyAction] of this.visible) {
      if (this.last.get(id) === key) continue;
      await keyAction.setImage(`icons/${this.command}/${state}.png`);
      await keyAction.setTitle(title);
      this.last.set(id, key);
    }
  }
}
for (const [id, , label, detail] of DECK_ACTIONS) {
  // Use the official decorator without duplicating 70 otherwise identical classes.
  class RegisteredAction extends CompanionAction {}
  const Decorated = action({ UUID: uuid(id) })(RegisteredAction, { kind: "class" } as any) ?? RegisteredAction;
  const instance = new Decorated(id, label, detail);
  instances.push(instance); streamDeck.actions.registerAction(instance);
}
await streamDeck.connect();
async function tick() {
  try {
    await client.poll();
    for (const instance of instances) await instance.render();
    await instances.find(instance => instance.command === inspectorCommand)?.inspect();
  } catch (error) { streamDeck.logger.error(String(error)); }
  finally { setTimeout(() => void tick(), 750); }
}
void tick();
