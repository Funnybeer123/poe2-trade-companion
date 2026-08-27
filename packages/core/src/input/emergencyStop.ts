export class EmergencyStop {
  #latched = false;

  trip(): void {
    this.#latched = true;
  }

  isLatched(): boolean {
    return this.#latched;
  }

  rearm(options: { explicit: true }): void {
    if (options?.explicit !== true) {
      throw new Error("Emergency stop rearm requires { explicit: true }");
    }
    this.#latched = false;
  }
}
