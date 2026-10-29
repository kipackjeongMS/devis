// The models the user's Copilot can run, read once per page and shared by every picker.

import { getJSON } from "./api.js";
import type { ModelChoice } from "./modelChoice.js";

let loading: Promise<ModelChoice[]> | null = null;
let known: ModelChoice[] | null = null;

/** The catalog once it's loaded, or null. */
export const modelCatalog = (): ModelChoice[] | null => known;

/** Load the catalog (once; a failed read is tried again next time). */
export function loadModelCatalog(): Promise<ModelChoice[]> {
  if (!loading) {
    loading = getJSON("/api/models")
      .then((r: { models?: string[]; catalog?: ModelChoice[] }) => {
        // An older service sends ids only.
        known = Array.isArray(r.catalog)
          ? r.catalog
          : Array.isArray(r.models)
            ? r.models.map((id) => ({ id, name: id, efforts: [] }))
            : [];
        return known;
      })
      .catch(() => {
        loading = null;
        return [];
      });
  }
  return loading;
}
