// The part of autofill that touches the page, in the content scripts' isolated world: `page.js` runs before
// `content.js` in every frame, and the service worker injects it into a frame that does not have it yet.
// Deciding what a field is happens outside, in the autofill engine; see background/engine.ts.
import type { CollectedPageDetails } from "../shared/messages.ts";
import { type CollectMode, collectFrame, isElementVisible } from "./collector/collect-frame.ts";
import { deepAll, deepFields } from "./collector/shadow-dom.ts";
import { extractAriaLabel, extractExplicitLabels } from "./collector/tree-walker.ts";
import { executeFill } from "./executor/fill.ts";
import type { FillResult, PageLogin } from "./types.ts";

const TEXTISH = ["text", "email", "tel", "number", ""];
const OTP_HINT = /one.?time|otp|totp|2fa|mfa|verification|confirmation.?code|security.?code|captcha/;

/** The field the user last focused for a login (content.ts); its form is the one they mean. */
let focused: Element | undefined;

/**
 * A login the user typed. This runs on submit, when the page is about to navigate and there is no time to
 * ask anything outside the frame, so it decides locally.
 */
function readLogin(form?: HTMLFormElement | null): PageLogin | null {
  // Read-only fields count: sites show the account name in one and only let the password be typed.
  // `form`: the one submitted; a filled but unsent form next to it (a password change) is not read.
  const inputs = deepFields().filter((el): el is HTMLInputElement => el instanceof HTMLInputElement && isElementVisible(el) && (!form || el.form === form));
  const hint = (i: HTMLInputElement) => [i.name, i.id, i.placeholder, extractAriaLabel(i), extractExplicitLabels(i)].join(" ").toLowerCase();
  const oneTimeCode = (i: HTMLInputElement) => i.autocomplete.toLowerCase().split(/\s+/).includes("one-time-code");
  // A masked one-time code is no password: saving it would overwrite the real one. Its own name or id only, not a
  // label: "Password (not your 2FA code)" is a password.
  const otpBox = (i: HTMLInputElement) => oneTimeCode(i) || OTP_HINT.test(`${i.name} ${i.id}`.toLowerCase());
  const filled = inputs.filter((i) => i.type === "password" && i.value && !otpBox(i));
  const editable = filled.filter((i) => !i.readOnly);
  const passwords = editable.length ? editable : filled;
  // On change-password forms (current / new / repeat) take the new password.
  const pass = passwords.find((i) => i.autocomplete.toLowerCase().split(/\s+/).includes("new-password")) ?? passwords.at(-1);
  if (!pass) return null;
  const before = inputs.slice(0, inputs.indexOf(pass)).filter((i) => TEXTISH.includes(i.type) && i.value && !oneTimeCode(i) && !OTP_HINT.test(hint(i)));
  // A form is the boundary again; outside one, the nearest filled field before the password is it.
  const user = pass.form ? before.filter((i) => i.form === pass.form).at(-1) : before.at(-1);
  return { url: location.href, username: user?.value ?? "", password: pass.value };
}

const ACCOUNT_HINT = /user|e-?mail|login|account|identifier|phone|kullan|hesap/;

/**
 * The account name on the first page of a two-step sign-in: a visible filled email / username box, and no password
 * field visible at all (a page with one is a normal login or sign-up, which readLogin handles).
 */
function readIdentifier(form?: HTMLFormElement | null): PageLogin | null {
  const inputs = deepFields().filter((el): el is HTMLInputElement => el instanceof HTMLInputElement && isElementVisible(el) && (!form || el.form === form));
  if (inputs.some((i) => i.type === "password")) return null;
  const named = (i: HTMLInputElement) => {
    const ac = i.autocomplete.toLowerCase().split(/\s+/);
    return i.type === "email" || ac.includes("username") || ac.includes("email") || ACCOUNT_HINT.test([i.name, i.id, extractAriaLabel(i)].join(" ").toLowerCase());
  };
  const user = inputs.filter((i) => TEXTISH.includes(i.type) && i.value.trim() && named(i));
  // One account box only: a form with several (a search, a contact form) says nothing about a sign-in.
  return user.length === 1 ? { url: location.href, username: user[0]!.value.trim(), password: "" } : null;
}

export const api = {
  /** Refuses a frame on another origin before it reads a single field. */
  collect(req: { origin: string; mode: CollectMode }): CollectedPageDetails | FillResult {
    if (location.origin !== req.origin) return { filled: false, reason: "origin" };
    return collectFrame(focused?.isConnected ? focused : undefined, req.mode);
  },
  /** What a focused field looks like to the engine. Only the content script calls this. */
  collectActive: (el: Element) => collectFrame(el, "ActiveFieldOnly"),
  setFocused(el: Element) {
    focused = el;
  },
  execute: executeFill,
  readLogin,
  readIdentifier,
  hasPasswordField: () => deepAll(document, "input[type=password]").length > 0,
};

export type PageApi = typeof api;

(globalThis as { warren?: PageApi }).warren ??= api;
