// Website icons from the server's icon service, fetched once per popup and checked for tone: a near-black logo
// (GitHub) vanishes on a dark theme and a near-white one on a light theme, so those get a contrasting plate.

export type Tone = "" | "tone-dark" | "tone-light";
export interface Favicon {
  url: string;
  tone: Tone;
}

/**
 * Tone of RGBA pixels: only see-through icons need a plate (an opaque square brings its own background),
 * and only when what is drawn is almost all dark or almost all light.
 */
export function toneOf(px: Uint8ClampedArray): Tone {
  let drawn = 0;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3]! < 128) continue;
    drawn++;
    sum += (0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!) / 255;
  }
  if (!drawn || drawn > 0.9 * (px.length / 4)) return "";
  const avg = sum / drawn;
  return avg < 0.25 ? "tone-dark" : avg > 0.8 ? "tone-light" : "";
}

const done = new Map<string, Favicon | null>();
const pending = new Map<string, Promise<Favicon | null>>();

/** Settled result for `src` (null: no icon), or undefined while it is still loading. */
export const cachedFavicon = (src: string): Favicon | null | undefined => done.get(src);

export function loadFavicon(src: string): Promise<Favicon | null> {
  let p = pending.get(src);
  if (!p) {
    p = (async () => {
      let blob: Blob;
      try {
        // Redirects followed: the server admin's ICON_SERVICE choice (google, duckduckgo…) is applied as configured.
        const r = await fetch(src, { credentials: "omit", referrerPolicy: "no-referrer" });
        if (!r.ok || !r.headers.get("content-type")?.startsWith("image/")) return null;
        blob = await r.blob();
      } catch {
        return null;
      }
      let tone: Tone = "";
      try {
        const bmp = await createImageBitmap(blob, { resizeWidth: 16, resizeHeight: 16 });
        const c = new OffscreenCanvas(16, 16).getContext("2d")!;
        c.drawImage(bmp, 0, 0);
        tone = toneOf(c.getImageData(0, 0, 16, 16).data);
      } catch {
        /* undecodable here (e.g. some .ico): shown as is, without a plate */
      }
      return { url: URL.createObjectURL(blob), tone };
    })().then((f) => (done.set(src, f), f));
    pending.set(src, p);
  }
  return p;
}
