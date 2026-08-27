export function generateLootFilter(options: {
  hideBelowScore: number;
  highlightUniques: boolean;
  name: string;
}): string {
  const lines = [
    `# PoE2 companion filter: ${options.name}`,
    `Show`,
    `    Class "Currency"`,
    `    SetTextColor 255 255 0`,
    ``,
  ];
  if (options.highlightUniques) {
    lines.push(`Show`, `    Rarity Unique`, `    SetFontSize 40`, `    PlayAlertSound 1 300`, ``);
  }
  lines.push(`Hide`, `    Rarity Normal`, `    ItemLevel < ${Math.max(1, options.hideBelowScore)}`, ``);
  return lines.join("\n");
}
