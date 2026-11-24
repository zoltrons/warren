// The part of autofill that touches the page, in the content scripts' isolated world: `page.js` runs before
// `content.js` in every frame, and the service worker injects it into a frame that does not have it yet.
// Deciding what a field is happens outside, in the autofill engine; see background/engine.ts.
import type { CollectedPageDetails } from "../shared/messages.ts";
import { type CollectMode, collectFrame, isElementVisible } from "./collector/collect-frame.ts";
import { deepAll, deepFields } from "./collector/shadow-dom.ts";
import { extractAriaLabel, extractExplicitLabels } from "./collector/tree-walker.ts";
import { executeFill } from "./executor/fill.ts";
import { MAX_PAGE_STRING, MAX_USERNAME_CHOICES } from "../shared/page-limits.ts";
import type { FillResult, PageLogin } from "./types.ts";

const TEXTISH = ["text", "email", "tel", "number", ""];
const OTP_HINT = /one.?time|otp|totp|2fa|mfa|verification|confirmation.?code|security.?code|captcha/;

const ACCOUNT_HINT = /user|e-?mail|login|account|identifier|phone|kullan|hesap/;
const autocompletes = (i: HTMLInputElement, token: string) => i.autocomplete.toLowerCase().split(/\s+/).includes(token);
/** A box that names itself an account: an e-mail, a username, a login. */
const accountField = (i: HTMLInputElement) =>
  i.type === "email" || autocompletes(i, "username") || autocompletes(i, "email") || ACCOUNT_HINT.test([i.name, i.id, extractAriaLabel(i)].join(" ").toLowerCase());

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
  const texts = inputs.filter((i) => TEXTISH.includes(i.type) && i.value.trim() && !oneTimeCode(i) && !OTP_HINT.test(hint(i)) && (!pass.form || i.form === pass.form));
  const at = inputs.indexOf(pass);
  // A form is the boundary again; outside one, the fields before the password. A sign-up asks for more than the
  // account (name, phone, invite code): the field that says it is the account wins, else the nearest one; a form
  // that asks for the e-mail after the password still names it.
  const near = texts.filter((i) => inputs.indexOf(i) < at);
  const user = near.findLast((i) => autocompletes(i, "username")) ?? near.findLast(accountField) ?? texts.find((i) => inputs.indexOf(i) > at && accountField(i)) ?? near.at(-1);
  const username = user?.value.trim() ?? "";
  // Outside a form any box on the page is in `texts` (a search, a newsletter): only the ones that name an account.
  const others = [...texts.filter(accountField), ...(pass.form ? texts : [])].map((i) => i.value.trim()).filter((v) => v !== username && v.length <= MAX_PAGE_STRING);
  // Outside a form, only a box before the password: a newsletter e-mail in the footer is no sign-up's account.
  const accountBox = inputs.some((i) => TEXTISH.includes(i.type) && accountField(i) && (pass.form ? i.form === pass.form : inputs.indexOf(i) < at));
  return { url: location.href, username, password: pass.value, usernames: [...new Set(others)].slice(0, MAX_USERNAME_CHOICES), accountBox };
}


/**
 * The account name on the first page of a two-step sign-in: a visible filled email / username box, and no password
 * field visible at all (a page with one is a normal login or sign-up, which readLogin handles).
 */
function readIdentifier(form?: HTMLFormElement | null): PageLogin | null {
  const inputs = deepFields().filter((el): el is HTMLInputElement => el instanceof HTMLInputElement && isElementVisible(el) && (!form || el.form === form));
  if (inputs.some((i) => i.type === "password")) return null;
  const user = inputs.filter((i) => TEXTISH.includes(i.type) && i.value.trim() && accountField(i));
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
  /** The login of the form the inline menu was opened in (setFocused): another form on the page is not read. */
  readFocusedLogin: () => readLogin(focused instanceof HTMLInputElement && focused.isConnected ? focused.form : undefined),
  readIdentifier,
  hasPasswordField: () => deepAll(document, "input[type=password]").length > 0,
};

export type PageApi = typeof api;

(globalThis as { warren?: PageApi }).warren ??= api;
