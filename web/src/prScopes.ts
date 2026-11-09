// The Settings model for one org's PR scopes: whole projects, or a busy project narrowed to picked repos.
// Pure, so the Settings card and its harness share it.

/** One chip: a whole project, or one repo picked inside it. */
export interface ScopeChip {
  project: string;
  repo?: string;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The chips for an org, in project order, each picked repo after its project's others. */
export function scopeChips(projects: string[], repos: Record<string, string[]>): ScopeChip[] {
  const chips: ScopeChip[] = [];
  for (const project of projects) {
    const picked = repos[project] || [];
    if (picked.length) for (const repo of picked) chips.push({ project, repo });
    else chips.push({ project });
  }
  return chips;
}

/**
 * Adds what the user typed: "Project" opts in the whole project (clearing any picked repos),
 * "Project/Repo" opts in that one repo (narrowing a whole project to it). Returns false when
 * the input isn't usable or changes nothing.
 */
export function addScope(projects: string[], repos: Record<string, string[]>, input: string): boolean {
  const raw = input.trim();
  const slash = raw.indexOf("/");
  const project = (slash < 0 ? raw : raw.slice(0, slash)).trim();
  const repo = slash < 0 ? "" : raw.slice(slash + 1).trim();
  if (!project || (slash >= 0 && (!repo || repo.includes("/")))) return false;

  const existing = projects.find((p) => same(p, project));
  const name = existing ?? project;
  if (!repo) {
    if (existing && !(repos[name] || []).length) return false;
    if (!existing) projects.push(name);
    delete repos[name];
    return true;
  }
  const picked = repos[name] || [];
  if (picked.some((r) => same(r, repo))) return false;
  if (!existing) projects.push(name);
  repos[name] = [...picked, repo];
  return true;
}

/** Removes a chip; a project's last repo takes the project with it, rather than widening it to the whole project. */
export function removeScope(projects: string[], repos: Record<string, string[]>, chip: ScopeChip): void {
  if (chip.repo) {
    const left = (repos[chip.project] || []).filter((r) => r !== chip.repo);
    if (left.length) {
      repos[chip.project] = left;
      return;
    }
  }
  delete repos[chip.project];
  const i = projects.indexOf(chip.project);
  if (i >= 0) projects.splice(i, 1);
}
