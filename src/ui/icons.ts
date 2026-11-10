// Lucide icons (lucide.dev), 24x24 outline glyphs drawn with round 1.75 px strokes at every size.
// Source: lucide-static 1.68.0, ISC License. Path data is used verbatim; <circle>, <line> and <rect>
// elements are rewritten as the equivalent paths so every glyph is a list of paths.
// Rows reserve the same 18px slot, so labels start on one vertical line on every screen.
const NS = "http://www.w3.org/2000/svg";

interface IconDef {
  /** Lucide icon this glyph comes from (kept for traceability when adding icons). */
  from: string;
  /** Filled as well as stroked (the favorite star). */
  solid?: boolean;
  paths: string[];
}

const icons = {
  arrowUp: { from: "arrow-up", paths: [
    "m5 12 7-7 7 7",
    "M12 19V5",
  ] },
  history: { from: "history", paths: [
    "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8",
    "M3 3v5h5",
    "M12 7v5l4 2",
  ] },
  fill: { from: "log-in", paths: [
    "m10 17 5-5-5-5",
    "M15 12H3",
    "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4",
  ] },
  memory: { from: "brain", paths: [
    "M12 18V5",
    "M15 13a4.17 4.17 0 01-3-4 4.17 4.17 0 01-3 4",
    "M17.707 6.294A3 3 0 1012 5a3 3 0 10-5.707 1.294",
    "M17.996 5.125a4 4 0 012.526 5.77",
    "M18 18a4 4 0 002-7.465",
    "M19.967 17.482a4 4 0 11-7.967.517 4 4 0 11-7.967-.517",
    "M6 18a4 4 0 01-2-7.465",
    "M6.004 5.125a4 4 0 00-2.526 5.77",
  ] },
  tune: { from: "sliders-horizontal", paths: [
    "M10 5H3",
    "M12 19H3",
    "M14 3v4",
    "M16 17v4",
    "M21 12h-9",
    "M21 19h-5",
    "M21 5h-7",
    "M8 10v4",
    "M8 12H3",
  ] },
  calendar: { from: "calendar", paths: [
    "M8 2v3",
    "M16 2v3",
    "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2z",
    "M3 9h18",
  ] },
  attach: { from: "paperclip", paths: [
    "m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551",
  ] },
  back: { from: "chevron-left", paths: [
    "m15 18-6-6 6-6",
  ] },
  card: { from: "credit-card", paths: [
    "M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2z",
    "M2 10L22 10",
    "M6 14h2",
  ] },
  check: { from: "check", paths: [
    "M20 6 9 17l-5-5",
  ] },
  chevron: { from: "chevron-right", paths: [
    "m9 18 6-6-6-6",
  ] },
  chevronDown: { from: "chevron-down", paths: [
    "m6 9 6 6 6-6",
  ] },
  close: { from: "x", paths: [
    "M18 6 6 18",
    "m6 6 12 12",
  ] },
  copy: { from: "copy", paths: [
    "M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2z",
    "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",
  ] },
  generator: { from: "wand-sparkles", paths: [
    "m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72",
    "m14 7 3 3",
    "M5 6v4",
    "M19 14v4",
    "M10 2v2",
    "M7 8H3",
    "M21 16h-4",
    "M11 3H9",
  ] },
  download: { from: "download", paths: [
    "M12 15V3",
    "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",
    "m7 10 5 5 5-5",
  ] },
  edit: { from: "pencil", paths: [
    "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
    "m15 5 4 4",
  ] },
  error: { from: "circle-alert", paths: [
    "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0",
    "M12 8L12 12",
    "M12 16L12.01 16",
  ] },
  external: { from: "external-link", paths: [
    "M15 3h6v6",
    "M10 14 21 3",
    "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  ] },
  eye: { from: "eye", paths: [
    "M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0",
    "M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
  ] },
  eyeOff: { from: "eye-off", paths: [
    "M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49",
    "M14.084 14.158a3 3 0 0 1-4.242-4.242",
    "M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143",
    "m2 2 20 20",
  ] },
  qr: { from: "qr-code", paths: [
    "M4 3h3a1 1 0 0 1 1 1v3a1 1 0 0 1 -1 1h-3a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1z",
    "M17 3h3a1 1 0 0 1 1 1v3a1 1 0 0 1 -1 1h-3a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1z",
    "M4 16h3a1 1 0 0 1 1 1v3a1 1 0 0 1 -1 1h-3a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1z",
    "M21 16h-3a2 2 0 0 0-2 2v3",
    "M21 21v.01",
    "M12 7v3a2 2 0 0 1-2 2H7",
    "M3 12h.01",
    "M12 3h.01",
    "M12 16v.01",
    "M16 12h1",
    "M21 12v.01",
    "M12 21v-1",
  ] },
  fingerprint: { from: "fingerprint-pattern", paths: [
    "M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4",
    "M14 13.12c0 2.38 0 6.38-1 8.88",
    "M17.29 21.02c.12-.6.43-2.3.5-3.02",
    "M2 12a10 10 0 0 1 18-6",
    "M2 16h.01",
    "M21.8 16c.2-2 .131-5.354 0-6",
    "M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2",
    "M8.65 22c.21-.66.45-1.32.57-2",
    "M9 6.8a6 6 0 0 1 9 5.2v2",
  ] },
  filter: { from: "list-filter", paths: [
    "M2 5h20",
    "M6 12h12",
    "M9 19h6",
  ] },
  folder: { from: "folder", paths: [
    "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
  ] },
  globe: { from: "globe", paths: [
    "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0",
    "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20",
    "M2 12h20",
  ] },
  home: { from: "house", paths: [
    "M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8",
    "M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  ] },
  info: { from: "info", paths: [
    "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0",
    "M12 16v-4",
    "M12 8h.01",
  ] },
  key: { from: "key-round", paths: [
    "M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z",
    "M16 7.5a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0 -1 0",
  ] },
  lock: { from: "lock", paths: [
    "M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-7a2 2 0 0 1 2 -2z",
    "M7 11V7a5 5 0 0 1 10 0v4",
  ] },
  unlock: { from: "lock-open", paths: [
    "M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-7a2 2 0 0 1 2 -2z",
    "M7 11V7a5 5 0 0 1 9.9-1",
  ] },
  mail: { from: "mail", paths: [
    "m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7",
    "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2z",
  ] },
  more: { from: "ellipsis", paths: [
    "M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
    "M18 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
    "M4 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
  ] },
  note: { from: "file-text", paths: [
    "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
    "M14 2v5a1 1 0 0 0 1 1h5",
    "M10 9H8",
    "M16 13H8",
    "M16 17H8",
  ] },
  panel: { from: "panel-right", paths: [
    "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2z",
    "M15 3v18",
  ] },
  phone: { from: "smartphone", paths: [
    "M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-16a2 2 0 0 1 2 -2z",
    "M12 18h.01",
  ] },
  remove: { from: "minus", paths: [
    "M5 12h14",
  ] },
  plus: { from: "plus", paths: [
    "M5 12h14",
    "M12 5v14",
  ] },
  refresh: { from: "refresh-cw", paths: [
    "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8",
    "M21 3v5h-5",
    "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",
    "M8 16H3v5",
  ] },
  search: { from: "search", paths: [
    "m21 21-4.34-4.34",
    "M3 11a8 8 0 1 0 16 0a8 8 0 1 0 -16 0",
  ] },
  send: { from: "send-horizontal", paths: [
    "M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z",
    "M6 12h16",
  ] },
  server: { from: "server", paths: [
    "M4 2h16a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-4a2 2 0 0 1 2 -2z",
    "M4 14h16a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-4a2 2 0 0 1 2 -2z",
    "M6 6L6.01 6",
    "M6 18L6.01 18",
  ] },
  settings: { from: "settings", paths: [
    "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915",
    "M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
  ] },
  shield: { from: "shield", paths: [
    "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
  ] },
  sort: { from: "arrow-up-down", paths: [
    "m21 16-4 4-4-4",
    "M17 20V4",
    "m3 8 4-4 4 4",
    "M7 4v16",
  ] },
  sortLines: { from: "arrow-down-wide-narrow", paths: [
    "m3 16 4 4 4-4",
    "M7 20V4",
    "M11 4h10",
    "M11 8h7",
    "M11 12h4",
  ] },
  star: { from: "star", solid: true, paths: [
    "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z",
  ] },
  starBorder: { from: "star", paths: [
    "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z",
  ] },
  timer: { from: "clock", paths: [
    "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0",
    "M12 6v6l4 2",
  ] },
  trash: { from: "trash-2", paths: [
    "M10 11v6",
    "M14 11v6",
    "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
    "M3 6h18",
    "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
  ] },
  user: { from: "user", paths: [
    "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2",
    "M8 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0",
  ] },
  logout: { from: "log-out", paths: [
    "m16 17 5-5-5-5",
    "M21 12H9",
    "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4",
  ] },
} satisfies Record<string, IconDef>;

export type IconName = keyof typeof icons;

export function icon(name: IconName, label?: string): SVGSVGElement {
  const def: IconDef = icons[name];
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", def.solid ? "i solid" : "i");
  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
  } else svg.setAttribute("aria-hidden", "true");
  for (const d of def.paths) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
