// What crosses between the service worker and the page's isolated world.

export interface FillResult {
  filled: boolean;
  reason?: "origin" | "noFields" | "noMatch" | "locked" | "error";
}

export interface PageLogin {
  url: string;
  username: string;
  password: string;
}

export type ValueFormat = "digits" | "expCompact" | "expLong" | "yearShort";

export interface ExecuteFill {
  /** The frame navigated away from this origin: never fill there. */
  origin: string;
  ops: { fieldId: number; value: string; format?: ValueFormat }[];
  /** Page load: only empty fields. */
  onlyEmpty?: boolean;
  /** Each only once its password field got a value. A click target that is gone by then submits nothing. */
  submit?: { kind: "click"; fieldId: number; passwordFieldId: number } | { kind: "enter"; fieldId: number };
}
