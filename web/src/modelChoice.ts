// Model and reasoning-effort choices for a Copilot chat (the Lead, a worker). Pure,
// so harnesses can import the compiled module; chatPane.ts paints the picker from it.

/** A model the user's Copilot can run, with the efforts it takes (none when it takes none). */
export interface ModelChoice {
  id: string;
  name: string;
  efforts: string[];
}

const EFFORT_LABEL: Record<string, string> = {
  none: "No reasoning",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export const effortLabel = (effort: string): string => EFFORT_LABEL[effort] || effort;

/** The efforts `model` takes; none for the Copilot default ("") or a model the catalog doesn't list. */
export function effortsFor(catalog: ModelChoice[] | null, model: string): string[] {
  if (!model) return [];
  return catalog?.find((m) => m.id === model)?.efforts ?? [];
}

/** The effort to keep when switching to `model`: the same one if it takes it, else its default (""). */
export function carriedEffort(catalog: ModelChoice[] | null, model: string, effort: string): string {
  return effort && effortsFor(catalog, model).includes(effort) ? effort : "";
}

/** What a chat's picker shows. */
export interface PickerState {
  /** The chosen model, or "" for the Copilot default. */
  model: string;
  /** The effort chosen with it, or "" for the model's default. */
  effort: string;
  /** What the session runs now, when known. */
  currentModel: string | null;
  currentEffort: string | null;
  catalog: ModelChoice[] | null;
  /** A turn is running: a switch applies when it ends. */
  busy: boolean;
  /** A switch is on its way. */
  switching: boolean;
  /** No session to set one for yet. */
  disabled?: boolean;
  /** What the chat calls its agent, for labels: "Devis", "appconfig-2". */
  who: string;
}

export interface PickerOption {
  value: string;
  label: string;
  selected: boolean;
}

export interface PickerView {
  models: PickerOption[];
  /** Null when the effort can't be chosen: the Copilot default, or a model without efforts. */
  efforts: PickerOption[] | null;
  modelTitle: string;
  effortTitle: string;
  /** A short note beside the picker ("Switching…", "after this turn"), or "". */
  note: string;
  disabled: boolean;
}

const running = (s: PickerState): string =>
  s.currentModel ? `${s.currentModel}${s.currentEffort ? ` (${effortLabel(s.currentEffort).toLowerCase()})` : ""}` : "";

export function pickerView(s: PickerState): PickerView {
  const ids = (s.catalog || []).map((m) => m.id);
  if (s.model && !ids.includes(s.model)) ids.unshift(s.model);
  const now = running(s);
  const models: PickerOption[] = [
    { value: "", label: !s.model && s.currentModel ? `Copilot default · ${s.currentModel}` : "Copilot default", selected: !s.model },
    ...ids.map((id) => ({ value: id, label: id, selected: id === s.model })),
  ];
  const takes = effortsFor(s.catalog, s.model);
  const list = s.effort && !takes.includes(s.effort) && s.model ? [...takes, s.effort] : takes;
  const efforts = s.model && list.length
    ? [
        { value: "", label: "Default effort", selected: !s.effort },
        ...list.map((e) => ({ value: e, label: effortLabel(e), selected: e === s.effort })),
      ]
    : null;
  // A choice that doesn't match what runs waits for the turn to end (or for the session to resume).
  const differs = !!s.model && !!s.currentModel && (s.model !== s.currentModel || (s.effort || "") !== (s.currentEffort || ""));
  const note = s.switching ? "Switching…" : differs && s.busy ? "after this turn" : "";
  return {
    models,
    efforts,
    modelTitle: now
      ? `${s.who} is running ${now}. Changing the model keeps the conversation${s.busy ? "; it applies when this turn ends" : ""}.`
      : s.model
        ? `${s.who} starts on ${s.model}.`
        : `${s.who} starts on the Copilot default.`,
    effortTitle: "Reasoning effort: how long the model thinks before it answers. More is slower and uses more of your quota.",
    note,
    disabled: !!s.disabled || s.switching,
  };
}

/** The choice after the model select changes: the effort carries over only when the new model takes it. */
export function nextChoice(s: PickerState, model: string): { model: string; effort: string } {
  return { model, effort: carriedEffort(s.catalog, model, s.effort) };
}
