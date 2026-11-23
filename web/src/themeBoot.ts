// Sets the color theme on <html> before the stylesheet paints, so a window never flashes the wrong one.
// A classic script (loaded in each page's <head>, no imports); theme.ts keeps it current after that.
// The pref comes from the URL in the desktop shell (?theme=, which the shell saves) or else from this
// browser's storage. "system" follows prefers-color-scheme, which the shell ties to Windows' setting.
(() => {
  const root = document.documentElement;
  let pref = new URLSearchParams(location.search).get("theme");
  if (!pref) {
    try {
      pref = localStorage.getItem("devis.theme");
    } catch {
      pref = null;
    }
  }
  if (pref !== "light" && pref !== "system") pref = "dark";
  const light = pref === "light" || (pref === "system" && matchMedia("(prefers-color-scheme: light)").matches);
  root.dataset.themePref = pref;
  root.dataset.theme = light ? "light" : "dark";
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", light ? "light" : "dark");
})();
