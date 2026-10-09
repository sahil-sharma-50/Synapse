export type StepKind =
  | "open_app"
  | "open_path"
  | "open_url"
  | "command"
  | "wait_url"
  | "browser"
  | "desktop"
  | "collect"
  | "draft"
  | "review"
  | "save_note";
export type Shell = "powershell" | "cmd" | "wsl";
export interface WorkflowStep {
  id: string;
  kind: StepKind;
  label: string;
  timeout_secs: number;
  expected: string;
  app?: string;
  path?: string;
  url?: string;
  shell?: Shell;
  command?: string;
  cwd?: string;
  distro?: string;
  background?: boolean;
  instruction?: string;
  output?: string;
  sources?: string[];
  artifact?: string;
  recorded?: Record<string, unknown>;
  unresolved?: string;
}
export interface Workflow {
  version: 1;
  id: string;
  revision: number;
  name: string;
  aliases: string[];
  context: string;
  inputs: { name: string; label: string; default_value: string }[];
  steps: WorkflowStep[];
  approved_revision: number | null;
}
export interface WorkflowRun {
  id: string;
  workflow_id: string;
  revision: number;
  status: string;
  step: number;
  steps: { id: string; status: string; evidence: string }[];
  artifacts: Record<string, string>;
  approval?: { id: string; description: string; kind?: "action" | "retry" } | null;
  error: string;
  started_at: number;
}
export interface WorkflowRecording {
  id: string;
  source: "browser" | "desktop";
  target: string;
  paused: boolean;
  steps: WorkflowStep[];
  stopped?: boolean;
  error?: string;
}
export const STEP_LABELS: Record<StepKind, string> = {
  open_app: "Open app",
  open_path: "Open project folder",
  open_url: "Open URL",
  command: "Run command",
  wait_url: "Wait for URL",
  browser: "Browser action",
  desktop: "Desktop action",
  collect: "Collect sources",
  draft: "Draft artifact",
  review: "Review artifact",
  save_note: "Save artifact to Notes",
};
export function newWorkflow(): Workflow {
  return {
    version: 1,
    id: "",
    revision: 0,
    name: "Untitled routine",
    aliases: [],
    context: "",
    inputs: [],
    steps: [],
    approved_revision: null,
  };
}
export function newStep(kind: StepKind): WorkflowStep {
  const common = {
    id: crypto.randomUUID(),
    kind,
    label: STEP_LABELS[kind],
    timeout_secs: 60,
    expected: "",
  };
  switch (kind) {
    case "open_app":
      return { ...common, app: "" };
    case "open_path":
      return { ...common, path: "" };
    case "open_url":
    case "wait_url":
      return { ...common, url: "" };
    case "command":
      return {
        ...common,
        shell: "powershell",
        command: "",
        cwd: "",
        distro: "",
        background: false,
      };
    case "review":
    case "save_note":
      return { ...common, artifact: "" };
    case "draft":
      return { ...common, instruction: "", sources: [], output: "draft" };
    case "collect":
      return { ...common, instruction: "", output: "sources" };
    default:
      return { ...common, instruction: "" };
  }
}
export function duplicateWorkflow(workflow: Workflow): Workflow {
  return {
    ...structuredClone(workflow),
    id: "",
    revision: 0,
    name: `${workflow.name} (copy)`,
    aliases: [],
    approved_revision: null,
    steps: workflow.steps.map((step) => ({ ...structuredClone(step), id: crypto.randomUUID() })),
  };
}
export function splitLines(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}
export function selectNoteSource(step: WorkflowStep, id: string): Partial<WorkflowStep> {
  if (!id) return {};
  if (step.kind === "collect") return { instruction: `note:${id}` };
  if (step.kind === "draft")
    return { sources: [...new Set([...(step.sources ?? []).filter(Boolean), `note:${id}`])] };
  return {};
}
export function runIsActive(run: WorkflowRun | null): boolean {
  return (
    !!run &&
    ["running", "pending", "waiting", "awaiting_approval", "waiting_approval", "paused"].includes(
      run.status,
    )
  );
}
