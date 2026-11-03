// Small card-network marks for the list and item tiles. Drawn here (no artwork is bundled or fetched), and
// the brand comes from the item's own brand field or its leading digits, worked out on this device only.

const NS = "http://www.w3.org/2000/svg";

type Shape = [tag: string, attrs: Record<string, string>, text?: string];

const card = (fill: string): Shape => ["rect", { width: "32", height: "20", rx: "3", fill }];
const word = (bg: string, text: string, size = "8"): Shape[] => [
  card(bg),
  ["text", { x: "16", y: "13.2", "text-anchor": "middle", "font-family": "system-ui,sans-serif", "font-weight": "800", "font-style": "italic", "font-size": size, fill: "#fff" }, text],
];
const rings = (a: string, b: string, mid: string): Shape[] => [
  card("#fff"),
  ["circle", { cx: "12.5", cy: "10", r: "6", fill: a }],
  ["circle", { cx: "19.5", cy: "10", r: "6", fill: b }],
  ["path", { d: "M16 5.3a6 6 0 0 1 0 9.4a6 6 0 0 1 0-9.4z", fill: mid }],
];

/** Keys are the brand names the Bitwarden clients store (see BRANDS in vault.ts). */
const MARKS: Record<string, Shape[]> = {
  Visa: word("#1a1f71", "VISA"),
  Mastercard: rings("#eb001b", "#f79e1b", "#ff5f00"),
  Maestro: rings("#eb001b", "#00a2e5", "#7375cf"),
  Amex: word("#2e77bc", "AMEX", "7"),
  Discover: word("#ff6000", "DISC", "7"),
  "Diners Club": word("#0079be", "DC"),
  JCB: word("#0b4ea2", "JCB"),
  UnionPay: word("#e21836", "UP"),
  RuPay: word("#097a44", "RuPay", "6.5"),
};

/** The mark for `brand`, or undefined for an unknown or "Other" brand. Built node by node, never from markup. */
export function cardMark(brand: string): SVGSVGElement | undefined {
  if (!Object.hasOwn(MARKS, brand)) return undefined; // brand is item data: no "constructor" lookups
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 32 20");
  svg.setAttribute("class", "card-mark");
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, attrs, text] of MARKS[brand]!) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text) el.textContent = text;
    svg.append(el);
  }
  return svg;
}
