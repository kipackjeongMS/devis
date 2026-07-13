// Thin fetch wrapper: parses JSON, surfaces API error messages as thrown Errors.

export async function api(path: string, opts?: RequestInit): Promise<any> {
  const r = await fetch(path, opts);
  const text = await r.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* raw */
  }
  if (!r.ok) throw new Error((data && data.error) || text || r.statusText);
  return data;
}

export const getJSON = (p: string): Promise<any> => api(p);

export const postJSON = (p: string, body: unknown): Promise<any> =>
  api(p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
