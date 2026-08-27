export class KillSwitch {
  private latched = false;

  trip(): void {
    this.latched = true;
  }

  rearm(): void {
    this.latched = false;
  }

  isLatched(): boolean {
    return this.latched;
  }
}
