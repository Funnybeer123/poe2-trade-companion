export interface BagTriageArgs {
  stage: "assess" | "capture" | "identify" | "drop" | "reconcile";
  fromScan?: string;
  replay?: string;
  journal?: string;
  output?: string;
  run: boolean;
  maxDrops: number;
  help: boolean;
}
export function parseBagTriageArgs(argv: string[]): BagTriageArgs {
  const values = new Map<string, string>(), flags = new Set<string>();
  for (const arg of argv) {
    const [key, ...rest] = arg.split("="), value = rest.join("=");
    if (["--run", "--help"].includes(key!) && rest.length === 0) {
      if (flags.has(key!)) throw new Error("Duplicate argument: " + key); flags.add(key!);
    } else if (["--stage", "--from-scan", "--replay", "--journal", "--output", "--max-drops"].includes(key!) && value.trim()) {
      if (values.has(key!)) throw new Error("Duplicate argument: " + key); values.set(key!, value);
    } else throw new Error("Unknown/incomplete argument: " + arg + ". No live adapter started.");
  }
  const stage = values.get("--stage") ?? (values.has("--from-scan") ? "assess" : "capture");
  if (!["assess", "capture", "identify", "drop", "reconcile"].includes(stage)) throw new Error("Invalid bag stage.");
  const numeric = values.get("--max-drops") ?? "1";
  if (!/^\d+$/.test(numeric) || Number(numeric) > 59) throw new Error("max-drops must be an integer from 0 to 59.");
  if (values.has("--max-drops") && stage !== "drop") throw new Error("max-drops applies only to the drop stage.");
  if (values.has("--replay") && flags.has("--run")) throw new Error("Replay cannot enable live input.");
  if (stage === "assess" && (!values.has("--from-scan") || values.has("--replay") || flags.has("--run") || values.has("--journal"))) throw new Error("Offline assessment requires only --from-scan and optional --output.");
  if (stage !== "assess" && values.has("--from-scan")) throw new Error("A stash report is not a resumable physical bag session.");
  if (["identify", "drop", "reconcile"].includes(stage) && !values.has("--journal")) throw new Error("This stage requires --journal=FILE.");
  if (["identify", "drop"].includes(stage) && !values.has("--replay") && !flags.has("--run")) throw new Error("Live mutation requires --run.");
  if (stage === "reconcile" && flags.has("--run")) throw new Error("Reconciliation is read-only.");
  return { stage: stage as BagTriageArgs["stage"], fromScan: values.get("--from-scan"), replay: values.get("--replay"),
    journal: values.get("--journal"), output: values.get("--output"), run: flags.has("--run"), maxDrops: Number(numeric), help: flags.has("--help") };
}
