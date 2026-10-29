// How expensive drawing is here. Without GPU compositing (a virtual machine, a remote
// session) Chromium draws every frame on the CPU, so the page drops effects that cost
// per frame: see html.lean in style.css. The desktop shell knows from the window's GPU
// status and says so in the URL (?render=lean|full); a plain browser asks WebGL.

export type RenderMode = "lean" | "full";

/** Renderer strings of software rasterizers: SwiftShader, WARP (Microsoft Basic Render Driver), Mesa's llvmpipe. */
const SOFTWARE = /swiftshader|basic render|llvmpipe|softpipe|software/i;

export function isSoftwareRenderer(renderer: string): boolean {
  return SOFTWARE.test(renderer);
}

/**
 * The mode to draw in: what the shell said, else what the probe found. `probe` is only
 * called when the shell didn't say, so a browser pays for the WebGL check once.
 */
export function pickRenderMode(param: string | null, probe: () => boolean): RenderMode {
  if (param === "lean" || param === "full") return param;
  return probe() ? "lean" : "full";
}

/** Is this page drawn without a GPU? A WebGL context that only software can give, or none, says yes. */
export function probeSoftwareRendering(): boolean {
  try {
    const canvas = document.createElement("canvas");
    // A major performance caveat (software rendering) refuses the context.
    const gl = canvas.getContext("webgl", { failIfMajorPerformanceCaveat: true }) as WebGLRenderingContext | null;
    if (!gl) return true;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return isSoftwareRenderer(renderer);
  } catch {
    return false;
  }
}
