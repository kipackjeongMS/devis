// A start dialog's Model and Reasoning effort fields, shared by the Workspace and the to-dos window.
import { loadModelCatalog, modelCatalog } from "./modelCatalog.js";
import { effortLabel, effortsFor } from "./modelChoice.js";

/** The fields' markup. Effort shows for a model that takes one. */
export const MODEL_FIELDS = `<label class="rp-label" for="jw-model">Model</label>
        <select id="jw-model" class="filter-select jv-field"><option value="">Copilot default</option></select>
        <label class="rp-label" for="jw-effort" hidden>Reasoning effort</label>
        <select id="jw-effort" class="filter-select jv-field" hidden><option value="">Default effort</option></select>`;

export function wireModelFields(dialog: HTMLElement): void {
  const model = dialog.querySelector<HTMLSelectElement>("#jw-model")!;
  const effort = dialog.querySelector<HTMLSelectElement>("#jw-effort")!;
  const label = dialog.querySelector<HTMLElement>('label[for="jw-effort"]')!;
  const sync = (): void => {
    const efforts = effortsFor(modelCatalog(), model.value);
    const keep = efforts.includes(effort.value) ? effort.value : "";
    effort.replaceChildren(new Option("Default effort", ""), ...efforts.map((e) => new Option(effortLabel(e), e)));
    effort.value = keep;
    effort.hidden = label.hidden = !efforts.length;
  };
  model.addEventListener("change", sync);
  void loadModelCatalog().then((catalog) => {
    for (const m of catalog) model.append(new Option(m.id, m.id));
    sync();
  });
}

export const chosenModel = (node: HTMLElement): { model: string | null; effort: string | null } => ({
  model: node.querySelector<HTMLSelectElement>("#jw-model")!.value || null,
  effort: node.querySelector<HTMLSelectElement>("#jw-effort")!.value || null,
});
