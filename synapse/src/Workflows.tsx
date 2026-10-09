import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirm } from "@tauri-apps/plugin-dialog";
import WindowChrome from "./WindowChrome";
import {
  duplicateWorkflow,
  newStep,
  newWorkflow,
  runIsActive,
  splitLines,
  selectNoteSource,
  STEP_LABELS,
  type Shell,
  type StepKind,
  type Workflow,
  type WorkflowRun,
  type WorkflowRecording,
  type WorkflowStep,
} from "./workflowModel";
import "./Workflows.css";

interface NoteChoice {
  id: string;
  title: string;
  preview: string;
  trashed_at: number | null;
}

function Field({
  label,
  value,
  onChange,
  multiline = false,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="wf-field">
      <span>{label}</span>
      {multiline ? (
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
        />
      ) : (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
        />
      )}
    </label>
  );
}

function StepEditor({
  step,
  index,
  count,
  update,
  remove,
  move,
}: {
  step: WorkflowStep;
  index: number;
  count: number;
  update: (patch: Partial<WorkflowStep>) => void;
  remove: () => void;
  move: (direction: number) => void;
}) {
  const [recordedJson, setRecordedJson] = useState(JSON.stringify(step.recorded ?? {}, null, 2));
  const [recordedError, setRecordedError] = useState("");
  const [notes, setNotes] = useState<NoteChoice[]>([]);
  const [notesError, setNotesError] = useState("");
  useEffect(() => {
    if (step.kind !== "collect" && step.kind !== "draft") return;
    let cancelled = false;
    void invoke<NoteChoice[]>("list_notes")
      .then((available) => {
        if (!cancelled) {
          setNotes(available.filter((note) => note.trashed_at === null));
          setNotesError("");
        }
      })
      .catch((reason) => {
        if (!cancelled) setNotesError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [step.kind]);
  const field = (
    key:
      "app" | "path" | "url" | "command" | "cwd" | "distro" | "instruction" | "output" | "artifact",
    label: string,
    multiline = false,
    placeholder?: string,
  ) => (
    <Field
      label={label}
      value={step[key] ?? ""}
      onChange={(value) => update({ [key]: value })}
      multiline={multiline}
      placeholder={placeholder}
    />
  );
  return (
    <details className="wf-card" open>
      <summary>
        {index + 1}.{" "}
        {step.label || STEP_LABELS[step.kind] || "Recorded action — edit before testing"}
      </summary>
      <div className="wf-actions">
        <button
          disabled={index === 0}
          onClick={() => move(-1)}
          aria-label={`Move step ${index + 1} up`}
        >
          Move up
        </button>
        <button
          disabled={index === count - 1}
          onClick={() => move(1)}
          aria-label={`Move step ${index + 1} down`}
        >
          Move down
        </button>
        <button onClick={remove}>Remove step</button>
      </div>
      <Field label="Step label" value={step.label} onChange={(label) => update({ label })} />
      <label className="wf-field">
        <span>Action</span>
        <select
          value={step.kind}
          onChange={(event) =>
            update({
              ...newStep(event.target.value as StepKind),
              id: step.id,
              label: step.label,
              recorded: undefined,
              unresolved: undefined,
            })
          }
        >
          {Object.entries(STEP_LABELS).map(([kind, label]) => (
            <option key={kind} value={kind}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {step.unresolved && (
        <div>
          <p className="wf-error">Needs manual review: {step.unresolved}</p>
          <button onClick={() => update({ unresolved: undefined })}>
            Mark corrected step reviewed
          </button>
        </div>
      )}
      {step.recorded && (
        <details>
          <summary>Recorded target and input data</summary>
          <p>
            Review selectors and replace personal text with input placeholders such as{" "}
            {"{{project}}"} before saving.
          </p>
          <Field
            label="Recorded action JSON"
            value={recordedJson}
            onChange={setRecordedJson}
            multiline
          />
          <button
            onClick={() => {
              try {
                const value: unknown = JSON.parse(recordedJson);
                if (!value || typeof value !== "object" || Array.isArray(value))
                  throw new Error("Recorded action must be a JSON object.");
                update({ recorded: value as Record<string, unknown>, unresolved: undefined });
                setRecordedError("");
              } catch (reason) {
                setRecordedError(String(reason));
              }
            }}
          >
            Apply reviewed recording
          </button>
          {recordedError && (
            <p role="alert" className="wf-error">
              {recordedError}
            </p>
          )}
        </details>
      )}
      {step.kind === "open_app" && field("app", "App name (as listed in Start menu)")}
      {step.kind === "open_path" && (
        <>
          {field(
            "path",
            "Project folder path",
            false,
            "C:\\Projects\\my-project or {{project_folder}}",
          )}
          <p>Opens an existing folder in File Explorer.</p>
        </>
      )}
      {(step.kind === "open_url" || step.kind === "wait_url") &&
        field("url", "URL", false, "https://… or http://localhost:3000")}
      {step.kind === "command" && (
        <>
          <label className="wf-field">
            <span>Shell</span>
            <select
              value={step.shell}
              onChange={(event) => update({ shell: event.target.value as Shell })}
            >
              <option value="powershell">PowerShell</option>
              <option value="cmd">Command Prompt</option>
              <option value="wsl">WSL</option>
            </select>
          </label>
          {field("command", "Command", true)}
          {field("cwd", "Working directory")}
          {step.shell === "wsl" && field("distro", "WSL distribution (optional)")}
          <label>
            <input
              type="checkbox"
              checked={step.background ?? false}
              onChange={(event) => update({ background: event.target.checked })}
            />{" "}
            Leave process running (for development servers)
          </label>
        </>
      )}
      {["browser", "desktop", "collect", "draft"].includes(step.kind) &&
        field("instruction", "Instructions", true)}
      {["collect", "draft"].includes(step.kind) && field("output", "Artifact name")}
      {["collect", "draft"].includes(step.kind) && (
        <>
          <label className="wf-field">
            <span>
              {step.kind === "collect"
                ? "Collect a Synapse note"
                : "Add a Synapse note as a source"}
            </span>
            <select
              value=""
              onChange={(event) => {
                update(selectNoteSource(step, event.target.value));
              }}
            >
              <option value="">Choose a note</option>
              {notes.map((note) => (
                <option key={note.id} value={note.id}>
                  {note.title || note.preview.slice(0, 80) || "Untitled note"}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() =>
              void invoke<NoteChoice[]>("list_notes")
                .then((available) => {
                  setNotes(available.filter((note) => note.trashed_at === null));
                  setNotesError("");
                })
                .catch((reason) => setNotesError(String(reason)))
            }
          >
            Refresh notes
          </button>
          {notesError && (
            <p role="alert" className="wf-error">
              Could not load notes: {notesError}
            </p>
          )}
          {!notesError && notes.length === 0 && (
            <p>No active notes found. Create a note in Notes Hub, then refresh.</p>
          )}
        </>
      )}
      {step.kind === "draft" && (
        <Field
          label="Source artifact names or note:<id> (one per line)"
          value={(step.sources ?? []).join("\n")}
          onChange={(value) => update({ sources: value.split("\n") })}
          multiline
        />
      )}
      {["review", "save_note"].includes(step.kind) && field("artifact", "Artifact name")}
      <Field
        label="Expected text (optional)"
        value={step.expected}
        onChange={(expected) => update({ expected })}
        multiline
      />
      <p>
        Checked literally against command output or observed app/page text. Leave empty when no text
        check is needed.
      </p>
      <label className="wf-field">
        <span>Timeout (seconds)</span>
        <input
          type="number"
          min="1"
          max="300"
          value={step.timeout_secs}
          onChange={(event) => update({ timeout_secs: Number(event.target.value) })}
        />
      </label>
    </details>
  );
}

function RunDetails({ run }: { run: WorkflowRun }) {
  return (
    <div className="wf-run">
      <p>
        <strong>{run.status}</strong> · Revision {run.revision}
        {run.started_at > 0 && (
          <>
            {" "}
            ·{" "}
            {new Date(
              run.started_at < 1e12 ? run.started_at * 1000 : run.started_at,
            ).toLocaleString()}
          </>
        )}
      </p>
      {run.error && <p className="wf-error">{run.error}</p>}
      <ol>
        {run.steps.map((step, index) => (
          <li key={step.id}>
            {index + 1}: {step.status}
            {step.evidence && <pre>{step.evidence}</pre>}
          </li>
        ))}
      </ol>
      {Object.entries(run.artifacts).map(([name, artifact]) => (
        <details key={name} className="wf-card">
          <summary>{name}</summary>
          <pre>{artifact}</pre>
        </details>
      ))}
    </div>
  );
}

function RunApproval({
  run,
  busy,
  respond,
}: {
  run: WorkflowRun;
  busy: boolean;
  respond: (approved: boolean) => void;
}) {
  if (!run.approval || !runIsActive(run)) return null;
  return (
    <div className="wf-approval">
      <h3>
        {run.approval.kind === "retry" ? "Step failed — retry?" : "Action needs your approval"}
      </h3>
      <p>{run.approval.description}</p>
      <div className="wf-actions">
        <button disabled={busy} onClick={() => respond(true)}>
          {run.approval.kind === "retry" ? "Retry step" : "Approve action"}
        </button>
        <button disabled={busy} onClick={() => respond(false)}>
          {run.approval.kind === "retry" ? "Stop run" : "Reject action"}
        </button>
      </div>
    </div>
  );
}

export default function Workflows({ embedded = false }: { embedded?: boolean }) {
  const [routines, setRoutines] = useState<Workflow[]>([]);
  const [editor, setEditor] = useState<Workflow | null>(null);
  const [baseline, setBaseline] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [stepKind, setStepKind] = useState<StepKind>("open_app");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<WorkflowRun[]>([]);
  const [source, setSource] = useState<"browser" | "desktop">("browser");
  const [target, setTarget] = useState("");
  const [targets, setTargets] = useState<{ id: string; name: string }[]>([]);
  const [recording, setRecording] = useState<WorkflowRecording | null>(null);
  const [runControlBusy, setRunControlBusy] = useState(false);
  const recordingRef = useRef<WorkflowRecording | null>(null);
  const recordingStopRequested = useRef(false);
  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);
  const [transfer, setTransfer] = useState("");
  const [terminal, setTerminal] = useState({
    shell: "powershell" as Shell,
    command: "",
    cwd: "",
    distro: "",
    background: false,
  });
  const [terminalOutput, setTerminalOutput] = useState("");
  const mounted = useRef(true);
  const dirty = !!editor && JSON.stringify(editor) !== baseline;
  const active = running || runIsActive(run);
  const saved = !!editor && routines.some((item) => item.id === editor.id);
  const switchBlocked = useRef(false);
  useEffect(() => {
    switchBlocked.current = dirty || active || !!recording;
  }, [dirty, active, recording]);

  const loadEditor = useCallback((workflow: Workflow, isSaved: boolean) => {
    setEditor(structuredClone(workflow));
    setBaseline(isSaved ? JSON.stringify(workflow) : "");
    setInputs(
      Object.fromEntries(workflow.inputs.map((input) => [input.name, input.default_value])),
    );
    setHistory([]);
    setRun(null);
  }, []);

  const reload = useCallback(async () => {
    setRoutines(await invoke<Workflow[]>("workflow_list"));
  }, []);
  useEffect(() => {
    mounted.current = true;
    void reload().catch((reason) => setError(String(reason)));
    const listeners = [
      listen<{ id: string }>("workflow-open", (event) => {
        void invoke<Workflow[]>("workflow_list")
          .then((available) => {
            setRoutines(available);
            const requested = available.find((item) => item.id === event.payload.id);
            if (!requested) return;
            if (switchBlocked.current) {
              setNotice(
                `Open “${requested.name}” from the routine list after saving changes or finishing the current activity.`,
              );
              return;
            }
            loadEditor(requested, true);
            setNotice("Fill in the routine inputs, then run the approved routine.");
          })
          .catch((reason) => setError(String(reason)));
      }),
      listen<WorkflowRun>("workflow-progress", (event) => {
        setRun((current) =>
          !current || current.id === event.payload.id || runIsActive(event.payload)
            ? event.payload
            : current,
        );
      }),
      listen("workflow-changed", () => {
        void reload().catch((reason) => setError(String(reason)));
      }),
      listen<WorkflowRecording>("workflow-recording", (event) => {
        if (event.payload.stopped && recordingRef.current?.id === event.payload.id) {
          if (!recordingStopRequested.current) {
            setEditor((current) =>
              current
                ? { ...current, steps: [...current.steps, ...event.payload.steps] }
                : { ...newWorkflow(), steps: event.payload.steps },
            );
            setNotice("Recording stopped. Captured steps were added for review.");
          }
          setRecording(null);
          return;
        }
        setRecording((current) => (current?.id === event.payload.id ? event.payload : current));
        if (event.payload.error) setError(event.payload.error);
      }),
      listen<{ text: string }>("workflow-terminal-output", (event) => {
        setTerminalOutput((current) => current + event.payload.text);
      }),
    ];
    void Promise.all(listeners)
      .then(async () => {
        const [currentRun, currentRecording] = await Promise.all([
          invoke<WorkflowRun | null>("workflow_current"),
          invoke<WorkflowRecording | null>("workflow_record_status"),
        ]);
        if (!mounted.current) return;
        setRun((current) => current ?? currentRun);
        if (currentRecording && !currentRecording.stopped) {
          setRecording((current) => current ?? currentRecording);
          setSource(currentRecording.source);
          setTarget(currentRecording.target);
          setTargets([{ id: currentRecording.target, name: currentRecording.target }]);
          setEditor((current) => current ?? newWorkflow());
          if (currentRecording.error) setError(currentRecording.error);
        }
      })
      .catch((reason) => {
        if (mounted.current) setError(String(reason));
      });
    return () => {
      mounted.current = false;
      listeners.forEach((listener) => {
        void listener.then((unlisten) => unlisten()).catch(() => {});
      });
    };
  }, [reload, loadEditor]);

  async function action(label: string, work: () => Promise<void>) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (reason) {
      setError(String(reason));
    } finally {
      if (mounted.current) setBusy("");
    }
  }
  async function canSwitch() {
    return (
      !dirty ||
      (await confirm("Discard unsaved routine changes?", {
        title: "Teach Synapse",
        kind: "warning",
      }))
    );
  }
  function patch(patch: Partial<Workflow>) {
    setEditor((current) => (current ? { ...current, ...patch } : current));
  }
  async function select(workflow: Workflow) {
    if (await canSwitch()) loadEditor(workflow, true);
  }
  async function save() {
    if (!editor) return;
    const result = await invoke<Workflow>("workflow_save", {
      workflow: {
        ...editor,
        aliases: splitLines(editor.aliases.join("\n")),
        steps: editor.steps.map((step) =>
          step.sources ? { ...step, sources: splitLines(step.sources.join("\n")) } : step,
        ),
      },
    });
    loadEditor(result, true);
    await reload();
    setNotice("Saved. Test this revision before approving it.");
  }
  async function startRun(test: boolean) {
    if (!editor || dirty || !saved) return;
    setRunning(true);
    setError("");
    setRun(null);
    try {
      const result = await invoke<WorkflowRun>("workflow_run", { id: editor.id, inputs, test });
      setRun(result);
      setHistory(await invoke<WorkflowRun[]>("workflow_history", { id: editor.id }));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRunning(false);
    }
  }
  async function respond(approved: boolean) {
    if (run?.approval)
      await invoke("workflow_respond", { runId: run.id, approvalId: run.approval.id, approved });
  }
  const controlsDisabled = !!busy || active || !!recording;
  const answerRun = (approved: boolean) => {
    setRunControlBusy(true);
    void respond(approved)
      .catch((reason) => setError(String(reason)))
      .finally(() => setRunControlBusy(false));
  };
  const cancelRun = () => {
    if (!run) return;
    setRunControlBusy(true);
    void invoke("workflow_cancel", { runId: run.id })
      .catch((reason) => setError(String(reason)))
      .finally(() => setRunControlBusy(false));
  };

  return (
    <div className={`workflows${embedded ? " workflows-embedded" : ""}`}>
      {!embedded && (
        <WindowChrome title="Teach Synapse" subtitle="Routines you can inspect, test, and reuse" />
      )}
      <div className="wf-layout">
        <aside className="wf-sidebar" aria-label="Saved routines">
          <h2>Routines</h2>
          <button
            disabled={controlsDisabled}
            onClick={() =>
              void action("Creating", async () => {
                if (await canSwitch()) loadEditor(newWorkflow(), false);
              })
            }
          >
            New routine
          </button>
          {routines.length === 0 && (
            <p>No saved routines yet. Describe a task or record a demonstration.</p>
          )}
          {routines.map((workflow) => (
            <button
              key={workflow.id}
              className={editor?.id === workflow.id ? "wf-selected" : ""}
              disabled={controlsDisabled}
              onClick={() => void action("Opening", () => select(workflow))}
            >
              <strong>{workflow.name}</strong>
              <small>
                {workflow.approved_revision === workflow.revision ? "Approved" : "Needs testing"} ·{" "}
                {workflow.steps.length} steps
              </small>
            </button>
          ))}
          <details>
            <summary>Import / export JSON</summary>
            <Field label="Routine JSON" value={transfer} onChange={setTransfer} multiline />
            <div className="wf-actions">
              <button
                disabled={controlsDisabled || !transfer.trim()}
                onClick={() =>
                  void action("Importing", async () => {
                    if (!(await canSwitch())) return;
                    const imported = await invoke<Workflow>("workflow_import", { json: transfer });
                    loadEditor(imported, true);
                    await reload();
                    setNotice("Imported. Review and test before approving.");
                  })
                }
              >
                Import
              </button>
              <button
                disabled={controlsDisabled || !saved || dirty}
                onClick={() =>
                  void action("Exporting", async () => {
                    setTransfer(await invoke<string>("workflow_export", { id: editor!.id }));
                    setNotice("Export JSON is ready to select and copy.");
                  })
                }
              >
                Export selected
              </button>
            </div>
          </details>
        </aside>
        <main className="wf-main">
          <div role="status" aria-live="polite">
            {busy || notice}
          </div>
          {error && (
            <p role="alert" className="wf-error">
              {error}
            </p>
          )}
          {run && run.workflow_id !== editor?.id && (
            <section className="wf-card">
              <h2>{routines.find((item) => item.id === run.workflow_id)?.name ?? "Routine run"}</h2>
              <RunApproval run={run} busy={runControlBusy} respond={answerRun} />
              {runIsActive(run) && (
                <button disabled={runControlBusy} onClick={cancelRun}>
                  Cancel run
                </button>
              )}
              <RunDetails run={run} />
            </section>
          )}
          {!editor ? (
            <div className="wf-empty">
              <h1>Teach Synapse a routine</h1>
              <p>
                Create a routine, describe what you do, or record a selected app or Chrome tab.
                Review its steps and test it before enabling an alias.
              </p>
            </div>
          ) : (
            <>
              <div className="wf-heading">
                <h1>{editor.name}</h1>
                <span>
                  {dirty ? "Unsaved changes" : `Revision ${editor.revision}`} ·{" "}
                  {editor.approved_revision === editor.revision && saved
                    ? "Approved"
                    : "Not approved"}
                </span>
              </div>
              <div className="wf-actions">
                <button
                  disabled={controlsDisabled || !dirty}
                  onClick={() => void action("Saving", save)}
                >
                  Save
                </button>
                <button
                  disabled={controlsDisabled}
                  onClick={() =>
                    void action("Duplicating", async () => {
                      if (await canSwitch()) loadEditor(duplicateWorkflow(editor), false);
                    })
                  }
                >
                  Duplicate
                </button>
                <button
                  disabled={controlsDisabled || !saved}
                  onClick={() =>
                    void action("Deleting", async () => {
                      if (
                        !(await confirm(`Delete “${editor.name}” and its run history?`, {
                          title: "Delete routine",
                          kind: "warning",
                        }))
                      )
                        return;
                      await invoke("workflow_delete", { id: editor.id });
                      setEditor(null);
                      setBaseline("");
                      await reload();
                    })
                  }
                >
                  Delete
                </button>
              </div>
              <fieldset disabled={controlsDisabled} className="wf-editor">
                <legend>Routine</legend>
                <Field label="Name" value={editor.name} onChange={(name) => patch({ name })} />
                <Field
                  label="Voice / typed aliases (one per line)"
                  value={editor.aliases.join("\n")}
                  onChange={(value) => patch({ aliases: value.split("\n") })}
                  multiline
                  placeholder="Start my workspace"
                />
                <Field
                  label="Context and constraints"
                  value={editor.context}
                  onChange={(context) => patch({ context })}
                  multiline
                  placeholder="Which project, app, sources, and expected outcome?"
                />
                <details className="wf-card">
                  <summary>Inputs · {editor.inputs.length}</summary>
                  <p>Use input placeholders in step fields, such as {"{{project}}"}.</p>
                  {editor.inputs.map((input, index) => (
                    <div className="wf-card" key={index}>
                      <Field
                        label="Input name"
                        value={input.name}
                        onChange={(name) =>
                          patch({
                            inputs: editor.inputs.map((value, i) =>
                              i === index ? { ...value, name } : value,
                            ),
                          })
                        }
                      />
                      <Field
                        label="Prompt label"
                        value={input.label}
                        onChange={(label) =>
                          patch({
                            inputs: editor.inputs.map((value, i) =>
                              i === index ? { ...value, label } : value,
                            ),
                          })
                        }
                      />
                      <Field
                        label="Default value"
                        value={input.default_value}
                        onChange={(default_value) =>
                          patch({
                            inputs: editor.inputs.map((value, i) =>
                              i === index ? { ...value, default_value } : value,
                            ),
                          })
                        }
                      />
                      <button
                        onClick={() =>
                          patch({ inputs: editor.inputs.filter((_, i) => i !== index) })
                        }
                      >
                        Remove input
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() =>
                      patch({
                        inputs: [
                          ...editor.inputs,
                          {
                            name: `input${editor.inputs.length + 1}`,
                            label: "",
                            default_value: "",
                          },
                        ],
                      })
                    }
                  >
                    Add input
                  </button>
                </details>
              </fieldset>
              <section className="wf-card">
                <h2>Teach</h2>
                <p>
                  Describe your task or capture context from the selected app. Generated steps stay
                  editable until you save and test them.
                </p>
                <Field
                  label="Describe the routine"
                  value={description}
                  onChange={setDescription}
                  multiline
                />
                <button
                  disabled={controlsDisabled || !description.trim()}
                  onClick={() =>
                    void action("Drafting steps", async () => {
                      const draft = await invoke<Workflow>("workflow_draft", {
                        description,
                        context: editor.context,
                      });
                      patch({
                        steps: [
                          ...editor.steps,
                          ...draft.steps.map((step) => ({ ...step, id: crypto.randomUUID() })),
                        ],
                        inputs: [
                          ...editor.inputs,
                          ...draft.inputs.filter(
                            (input) =>
                              !editor.inputs.some((existing) => existing.name === input.name),
                          ),
                        ],
                        name: editor.name === "Untitled routine" ? draft.name : editor.name,
                        context: draft.context || editor.context,
                      });
                      setNotice(
                        "Draft steps added. Review actions, checkpoints, and permissions before testing.",
                      );
                    })
                  }
                >
                  Draft steps with AI
                </button>
                <label className="wf-field">
                  <span>Demonstration source</span>
                  <select
                    disabled={!!recording || active}
                    value={source}
                    onChange={(event) => {
                      setSource(event.target.value as "browser" | "desktop");
                      setTargets([]);
                      setTarget("");
                    }}
                  >
                    <option value="browser">Chrome tab</option>
                    <option value="desktop">Windows app</option>
                  </select>
                </label>
                <button
                  disabled={controlsDisabled}
                  onClick={() =>
                    void action("Capturing context", async () => {
                      const context = await invoke<string>("workflow_demonstrate", { source });
                      patch({ context: [editor.context, context].filter(Boolean).join("\n\n") });
                      setNotice("Selected app context added to the routine.");
                    })
                  }
                >
                  Capture selected {source === "browser" ? "tab" : "app"} context
                </button>
                <div className="wf-actions">
                  <button
                    disabled={controlsDisabled}
                    onClick={() =>
                      void action("Finding recording targets", async () => {
                        const available = await invoke<{ id: string; name: string }[]>(
                          "workflow_record_targets",
                          { source },
                        );
                        setTargets(available);
                        setTarget(available[0]?.id ?? "");
                        if (!available.length)
                          setNotice(
                            "No targets found. Open Chrome with browser control enabled or open the Windows app, then refresh.",
                          );
                      })
                    }
                  >
                    Find {source === "browser" ? "Chrome tabs" : "Windows apps"}
                  </button>
                </div>
                <label className="wf-field">
                  <span>Record only this target</span>
                  <select
                    disabled={!!recording || active}
                    value={target}
                    onChange={(event) => setTarget(event.target.value)}
                  >
                    <option value="">Choose a target</option>
                    {targets.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="wf-actions">
                  {!recording ? (
                    <button
                      disabled={controlsDisabled || !target.trim()}
                      onClick={() =>
                        void action("Starting recording", async () => {
                          const result = await invoke<WorkflowRecording>("workflow_record_start", {
                            source,
                            target,
                          });
                          setRecording(result);
                        })
                      }
                    >
                      Start recording
                    </button>
                  ) : (
                    <>
                      <button
                        disabled={!!busy}
                        onClick={() =>
                          void action("Updating recording", async () => {
                            await invoke("workflow_record_pause", {
                              id: recording.id,
                              paused: !recording.paused,
                            });
                            setRecording({ ...recording, paused: !recording.paused });
                          })
                        }
                      >
                        {recording.paused ? "Resume" : "Pause"}
                      </button>
                      <button
                        disabled={!!busy}
                        onClick={() =>
                          void action("Stopping recording", async () => {
                            recordingStopRequested.current = true;
                            try {
                              const steps = await invoke<WorkflowStep[]>("workflow_record_stop", {
                                id: recording.id,
                              });
                              patch({ steps: [...editor.steps, ...steps] });
                              setRecording(null);
                              setNotice(
                                "Recorded steps added. Review their targets and checkpoints before testing.",
                              );
                            } finally {
                              recordingStopRequested.current = false;
                            }
                          })
                        }
                      >
                        Stop and add steps
                      </button>
                      <span role="status">
                        {recording.paused ? "Paused" : "Recording"} · {recording.steps.length}{" "}
                        actions
                      </span>
                    </>
                  )}
                </div>
              </section>
              <details className="wf-card">
                <summary>Capture a command session</summary>
                <p>
                  Execute a command with native confirmation, inspect the result, then keep it as a
                  reproducible step. Commands can change files and run applications.
                </p>
                <label className="wf-field">
                  <span>Shell</span>
                  <select
                    disabled={controlsDisabled}
                    value={terminal.shell}
                    onChange={(event) =>
                      setTerminal({ ...terminal, shell: event.target.value as Shell })
                    }
                  >
                    <option value="powershell">PowerShell</option>
                    <option value="cmd">Command Prompt</option>
                    <option value="wsl">WSL</option>
                  </select>
                </label>
                <Field
                  label="Command"
                  value={terminal.command}
                  onChange={(command) => setTerminal({ ...terminal, command })}
                  multiline
                />
                <Field
                  label="Working directory"
                  value={terminal.cwd}
                  onChange={(cwd) => setTerminal({ ...terminal, cwd })}
                />
                {terminal.shell === "wsl" && (
                  <Field
                    label="WSL distribution"
                    value={terminal.distro}
                    onChange={(distro) => setTerminal({ ...terminal, distro })}
                  />
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={terminal.background}
                    onChange={(event) =>
                      setTerminal({ ...terminal, background: event.target.checked })
                    }
                  />{" "}
                  Leave process running
                </label>
                <button
                  disabled={controlsDisabled || !terminal.command.trim()}
                  onClick={() =>
                    void action("Running command", async () => {
                      const result = await invoke<{
                        stdout: string;
                        stderr: string;
                        exit_code: number | null;
                        launched: boolean;
                      }>("workflow_terminal", { spec: terminal, timeoutSecs: 60 });
                      setTerminalOutput(
                        `Exit: ${result.exit_code ?? (result.launched ? "Background process launched" : "Unknown")}\n${result.stdout}\n${result.stderr}`,
                      );
                      if (result.exit_code === 0 || result.launched) {
                        patch({
                          steps: [
                            ...editor.steps,
                            {
                              ...newStep("command"),
                              ...terminal,
                              label: terminal.command.split("\n")[0],
                            },
                          ],
                        });
                        setNotice("Command succeeded; its step was added.");
                      } else setError("Command failed. Inspect the output; no step was added.");
                    })
                  }
                >
                  Run with confirmation and capture
                </button>
                {terminalOutput && <pre>{terminalOutput}</pre>}
              </details>
              <section>
                <h2>Steps · {editor.steps.length}</h2>
                <fieldset disabled={controlsDisabled} className="wf-editor">
                  <legend className="wf-sr-only">Edit steps</legend>
                  {editor.steps.map((step, index) => (
                    <StepEditor
                      key={step.id}
                      step={step}
                      index={index}
                      count={editor.steps.length}
                      update={(update) =>
                        patch({
                          steps: editor.steps.map((value) =>
                            value.id === step.id ? { ...value, ...update } : value,
                          ),
                        })
                      }
                      remove={() =>
                        patch({ steps: editor.steps.filter((value) => value.id !== step.id) })
                      }
                      move={(direction) => {
                        const steps = [...editor.steps];
                        [steps[index], steps[index + direction]] = [
                          steps[index + direction],
                          steps[index],
                        ];
                        patch({ steps });
                      }}
                    />
                  ))}
                  <div className="wf-actions">
                    <select
                      aria-label="New step action"
                      value={stepKind}
                      onChange={(event) => setStepKind(event.target.value as StepKind)}
                    >
                      {Object.entries(STEP_LABELS).map(([kind, label]) => (
                        <option key={kind} value={kind}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <button onClick={() => patch({ steps: [...editor.steps, newStep(stepKind)] })}>
                      Add step
                    </button>
                  </div>
                </fieldset>
              </section>
              <section className="wf-card">
                <h2>Test and approve</h2>
                <p>
                  Testing executes real actions, including commands and writes. Save your changes,
                  test every step, and inspect the resulting artifacts. Approval enables aliases for
                  this exact revision.
                </p>
                {editor.inputs.map((input) => (
                  <Field
                    key={input.name}
                    label={input.label || input.name}
                    value={inputs[input.name] ?? input.default_value}
                    onChange={(value) => setInputs({ ...inputs, [input.name]: value })}
                  />
                ))}
                <div className="wf-actions">
                  <button
                    disabled={controlsDisabled || dirty || !saved || !editor.steps.length}
                    onClick={() => void startRun(true)}
                  >
                    Test routine
                  </button>
                  <button
                    disabled={
                      controlsDisabled ||
                      dirty ||
                      !saved ||
                      editor.approved_revision !== editor.revision
                    }
                    onClick={() => void startRun(false)}
                  >
                    Run approved routine
                  </button>
                  <button
                    disabled={
                      controlsDisabled ||
                      dirty ||
                      !saved ||
                      editor.approved_revision === editor.revision
                    }
                    onClick={() =>
                      void action("Approving revision", async () => {
                        await invoke("workflow_approve", {
                          id: editor.id,
                          revision: editor.revision,
                        });
                        const approved = { ...editor, approved_revision: editor.revision };
                        setEditor(approved);
                        setBaseline(JSON.stringify(approved));
                        await reload();
                        setNotice("Revision approved. Its aliases can now run it.");
                      })
                    }
                  >
                    Approve revision
                  </button>
                  {active && (
                    <button disabled={!run || runControlBusy} onClick={cancelRun}>
                      Cancel run
                    </button>
                  )}
                </div>
                {active && (
                  <p role="status">
                    {run
                      ? `${run.status} · step ${run.step + 1} of ${editor.steps.length}`
                      : "Starting routine…"}
                  </p>
                )}
                {run && <RunApproval run={run} busy={runControlBusy} respond={answerRun} />}
                {run && <RunDetails run={run} />}
              </section>
              <details className="wf-card">
                <summary>Run history</summary>
                <button
                  disabled={!!busy || active || !saved}
                  onClick={() =>
                    void action("Clearing history", async () => {
                      if (
                        !(await confirm(
                          "Delete this routine’s run history and captured artifacts?",
                          { title: "Clear run history", kind: "warning" },
                        ))
                      )
                        return;
                      await invoke("workflow_clear_history", { id: editor.id });
                      setHistory([]);
                      setRun(null);
                      setNotice("Run history cleared.");
                    })
                  }
                >
                  Clear history and artifacts
                </button>
                <button
                  disabled={!!busy || !saved}
                  onClick={() =>
                    void action("Loading history", async () =>
                      setHistory(
                        await invoke<WorkflowRun[]>("workflow_history", { id: editor.id }),
                      ),
                    )
                  }
                >
                  Refresh history
                </button>
                {history.length === 0 && <p>No runs loaded.</p>}
                {history.map((item) => (
                  <details key={item.id}>
                    <summary>
                      {item.status} · revision {item.revision} · {item.id.slice(0, 8)}
                    </summary>
                    <RunDetails run={item} />
                  </details>
                ))}
              </details>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
