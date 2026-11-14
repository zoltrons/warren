// Vault list: search, filters, sort, rows and their quick actions, the "this site" suggestions.
import type { FillResult, PageLogin } from "../autofill/types.ts";
import { byRelevance, type Clause, folded, matchesQuery, parseQuery, type Searchable } from "../shared/search.ts";
import type { VaultItem } from "../shared/messages.ts";
import { type Child, chipRow, h, plural, send, setUiPref, t, uiPref } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import { type Json, type Ctx, SORT_KEY, SORTS, loadOpened, recentShown, clearOpened, st, settingsOf, str, obj, webUrl, tile, toast, copy, iconButton, errorBox, topBar, sectionTitle, type MenuItem, menu, refreshPageMatches, syncNow, open } from "./vault-shared.ts";
import { label, vaultAction } from "./vault-item.ts";
import { newItem, startEdit, sitePrefill } from "./vault-edit.ts";

// ---------- list ----------

export const TYPE_LABEL: Record<number, string> = { 1: "typeLogin", 2: "typeNote", 3: "typeCard", 4: "typeIdentity", 5: "typeSshKey", 6: "typeBankAccount", 7: "typeDriversLicense", 8: "typePassport" };

export const TYPE_ENGLISH: Record<number, string> = { 1: "login", 2: "note", 3: "card", 4: "identity", 5: "ssh" };

// A new list (sync, save, rename) brings new item objects, so an entry never outlives its item's text.
export const searchCache = new WeakMap<VaultItem, Searchable>();

export function searchable(i: VaultItem): Searchable {
  let s = searchCache.get(i);
  if (!s) searchCache.set(i, (s = folded(searchFields(i))));
  return s;
}

export function searchFields(i: VaultItem): Searchable {
  const typeKey = TYPE_LABEL[i.type];
  const flags = [i.favorite && "favorite", i.reused && "reused", i.weak && "weak", i.hasTotp && "totp", i.reprompt && "reprompt"].filter((f): f is string => !!f);
  return {
    name: i.name,
    sub: i.sub,
    uris: i.uris,
    folder: st.list?.folders.find((f) => f.id === i.folderId)?.name ?? "",
    type: [typeKey ? t(typeKey) : "", TYPE_ENGLISH[i.type] ?? ""].filter(Boolean),
    flags,
  };
}

export function matches(i: VaultItem, clauses: Clause[]): boolean {
  const f = st.folder;
  if (f === "fav") {
    if (!i.favorite) return false;
  } else if (f.startsWith("t:")) {
    if (i.type !== Number(f.slice(2))) return false;
  } else if (f === "reused") {
    if (!i.reused) return false;
  } else if (f === "weak") {
    if (!i.weak) return false;
  } else if (f === "none") {
    if (i.folderId) return false;
  } else if (f && f !== "trash" && f !== "archive" && i.folderId !== f) return false;
  return !clauses.length || matchesQuery(clauses, searchable(i));
}

export function sortItems(items: VaultItem[]): VaultItem[] {
  const byName = (a: VaultItem, b: VaultItem) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);
  const list = [...items];
  if (st.sort === "nameDesc") return list.sort((a, b) => byName(b, a));
  if (st.sort === "updated") return list.sort((a, b) => (b.revisionDate ?? 0) - (a.revisionDate ?? 0) || byName(a, b));
  if (st.sort === "created") return list.sort((a, b) => (b.creationDate ?? 0) - (a.creationDate ?? 0) || byName(a, b));
  if (st.sort === "opened") {
    const opened = loadOpened();
    return list.sort((a, b) => (opened[b.id]?.n ?? 0) - (opened[a.id]?.n ?? 0) || byName(a, b));
  }
  return list.sort(byName);
}

// ---------- quick actions ----------

/** The full item for a quick action. A flagged one opens its view instead, where the master password is asked. */
export async function fullItem(ctx: Ctx, id: string): Promise<Json | undefined> {
  const r = await send<Json>({ type: "getItem", id });
  if (r.ok) return r.data;
  if (r.code === "reprompt") open(ctx, { kind: "item", id });
  else toast(ctx, r.error, { error: true });
  return undefined;
}

export async function copyOf(ctx: Ctx, id: string, pick: (item: Json) => string) {
  const item = await fullItem(ctx, id);
  if (!item) return;
  const value = pick(item);
  if (value) await copy(ctx, value);
  else toast(ctx, t("nothingToCopy"));
}

export async function copyTotp(ctx: Ctx, id: string) {
  const r = await send<{ code: string }>({ type: "totp", id });
  if (r.ok) await copy(ctx, r.data.code);
  else if (r.code === "reprompt") open(ctx, { kind: "item", id });
  else toast(ctx, r.error, { error: true });
}

export const iconMode = () => !settingsOf()?.quickActionMenus;

/**
 * Quick actions of a list row, like the official extension. By default one button each for a login:
 * open the website, copy the username, the password and the code (dimmed when the login has none); for a
 * card: copy the number and the security code. With
 * the "Compact row actions" setting: a copy button (a menu when there is a choice) and "⋮" with
 * favorite, website, edit and clone. Secrets are fetched on use, through the worker's re-prompt check.
 */
export function rowActions(ctx: Ctx, i: VaultItem): Child[] {
  if (i.failed) return [];
  const field = (o: string, k: string) => (item: Json) => str(obj(item[o])?.[k]);
  const name = i.name || t("untitled");
  if (iconMode()) {
    const button = (ic: IconName, text: string, run: () => void, enabled: boolean) =>
      iconButton(ic, `${text} (${name})`, run, { class: "icon-btn sm quick-action", disabled: !enabled });
    if (i.type === 3)
      return [
        button("card", t("copyField", label("number")), () => void copyOf(ctx, i.id, field("card", "number")), true),
        button("key", t("copyField", label("code")), () => void copyOf(ctx, i.id, field("card", "code")), true),
      ];
    if (i.type !== 1) return [];
    const url = i.uris.map(webUrl).find(Boolean);
    return [
      button("external", t("openWebsite"), () => void chrome.tabs.create({ url: url! }), !!url),
      button("user", t("copyField", label("username")), () => void copy(ctx, i.sub), !!i.sub),
      button("key", t("copyField", label("password")), () => void copyOf(ctx, i.id, field("login", "password")), !i.noPassword),
      button("timer", t("copyField", t("oneTimeCode")), () => void copyTotp(ctx, i.id), i.hasTotp),
    ];
  }
  const copies: MenuItem[] =
    i.type === 1
      ? [
          ...(i.sub ? [{ label: t("copyField", label("username")), icon: "user" as const, onClick: () => void copy(ctx, i.sub) }] : []),
          { label: t("copyField", label("password")), icon: "key", onClick: () => void copyOf(ctx, i.id, field("login", "password")) },
          ...(i.hasTotp ? [{ label: t("copyField", t("oneTimeCode")), icon: "timer" as const, onClick: () => void copyTotp(ctx, i.id) }] : []),
        ]
      : i.type === 3
        ? [
            { label: t("copyField", label("number")), icon: "card", onClick: () => void copyOf(ctx, i.id, field("card", "number")) },
            { label: t("copyField", label("code")), icon: "key", onClick: () => void copyOf(ctx, i.id, field("card", "code")) },
          ]
        : i.type === 2
          ? [{ label: t("copyField", t("notes")), icon: "note", onClick: () => void copyOf(ctx, i.id, (item) => str(item.notes)) }]
          : [];
  const url = i.uris.map(webUrl).find(Boolean);
  const editable = !i.readOnly && st.folder !== "trash";
  const more: MenuItem[] = [
    ...(editable
      ? [
          {
            label: t(i.favorite ? "unfavorite" : "favorite"),
            icon: (i.favorite ? "starBorder" : "star") as IconName,
            onClick: () => void fullItem(ctx, i.id).then((item) => item && vaultAction(ctx, { type: "saveItem", item: { ...item, favorite: !i.favorite } }, "saved", false)),
          },
        ]
      : []),
    ...(url ? [{ label: t("openWebsite"), icon: "external" as const, onClick: () => void chrome.tabs.create({ url }) }] : []),
    ...(editable
      ? [
          { label: t("edit"), icon: "edit" as const, onClick: () => void fullItem(ctx, i.id).then((item) => item && startEdit(ctx, item)) },
          {
            label: t("clone"),
            icon: "copy" as const,
            onClick: () =>
              void fullItem(ctx, i.id).then(
                (item) => item && startEdit(ctx, { ...structuredClone(item), id: undefined, attachments: null, name: `${str(item.name)} ${t("copySuffix")}`, passwordHistory: null }, {}, true),
              ),
          },
        ]
      : []),
  ];
  const copyBtn: HTMLElement | null =
    copies.length === 1
      ? iconButton("copy", `${copies[0]!.label} (${name})`, copies[0]!.onClick, { class: "icon-btn sm" })
      : copies.length
        ? iconButton("copy", t("copyOptions", name), () => menu(copyBtn!, t("copyOptions", name), copies), { class: "icon-btn sm", "aria-haspopup": "menu" })
        : null;
  const moreBtn: HTMLElement | null = more.length
    ? iconButton("more", t("moreOptions", name), () => menu(moreBtn!, t("moreOptions", name), more), { class: "icon-btn sm", "aria-haspopup": "menu" })
    : null;
  return [copyBtn, moreBtn];
}

/** The status marks after a row's name (code, weak or reused, favorite), the same in every list section. */
export function rowMarks(i: VaultItem): Child[] {
  return [
    i.hasTotp && !(iconMode() && i.type === 1) ? h("span", { class: "meta" }, icon("timer", t("oneTimeCode"))) : null,
    i.reused || i.weak ? h("span", { class: "meta warn" }, icon("error", t(i.reused ? "filterReused" : "filterWeak"))) : null,
    i.favorite ? h("span", { class: "meta fav" }, icon("star", t("favorite"))) : null,
  ];
}

/** What a screen reader says for a row: the action, then what the eye sees in it (username and the marks). */
export function rowLabel(i: VaultItem, name: string): string {
  const marks = [i.sub, i.hasTotp ? t("oneTimeCode") : "", i.reused ? t("filterReused") : i.weak ? t("filterWeak") : "", i.favorite ? t("favorite") : ""];
  return [t("showItem", name), ...marks.filter(Boolean)].join(", ");
}

export function itemRow(ctx: Ctx, i: VaultItem): HTMLElement {
  const name = i.failed ? t("decryptFailed") : i.name || t("untitled");
  return h(
    "div",
    // The row is the list item; the button inside keeps its button role (a role on it would replace that).
    { class: "row", role: "listitem" },
    h(
      "button",
      {
        type: "button",
        class: "row-main",
        "data-item": i.id,
        "aria-label": rowLabel(i, name),
        onclick: () => open(ctx, { kind: "item", id: i.id }),
      },
      tile(i.name, i.type, i.uris, i.brand),
      h(
        "div",
        { class: "body" },
        h("span", { class: "title" }, name),
        h("span", { class: "sub" }, i.sub || t(TYPE_LABEL[i.type] ?? "untitled")),
      ),
      ...rowMarks(i),
    ),
    ...rowActions(ctx, i),
    // Fill sits only on the rows listed for this page (suggestionRow): repeated down the whole vault it hid which
    // rows match. Any other item still fills from its own view ("Fill this site", with the mismatch check).
  );
}

export function emptyState(ctx: Ctx, q: string): HTMLElement {
  const filtered = !!(q || st.folder);
  const key = st.folder === "trash" ? "trashEmpty" : st.folder === "archive" ? "archiveEmpty" : st.folder === "fav" ? "favoritesEmpty" : filtered ? "noMatches" : "vaultEmpty";
  // What fills this view, said where it is empty.
  const hint = st.folder === "trash" ? "trashEmptyHint" : st.folder === "archive" ? "archiveEmptyHint" : st.folder === "fav" ? undefined : filtered ? "noMatchesHint" : "vaultEmptyHint";
  return h(
    "div",
    { class: "empty" },
    h("strong", {}, t(key)),
    hint ? h("p", {}, t(hint)) : null,
    !filtered
      ? h(
          "div",
          { class: "row-actions" },
          h("button", { type: "button", class: "btn text small", onclick: () => ctx.goto("settings", t("importVault")) }, icon("download"), t("importVault")),
          h("button", { type: "button", class: "btn filled small", onclick: () => void newItem(ctx) }, icon("plus"), t("newItem")),
        )
      : null,
    filtered
      ? h(
          "button",
          {
            type: "button",
            class: "btn text small",
            onclick: () => {
              st.query = "";
              st.folder = "";
              ctx.rerender();
            },
          },
          // Names what is on: a typed search alone is cleared, not "filters".
          t(st.folder ? "clearFilters" : "clearSearch"),
        )
      : null,
  );
}

export function fillList(ctx: Ctx, box: HTMLElement, items: VaultItem[], q: string) {
  const nodes: Child[] = [];
  // While searching, the best matches lead (relevance), so there are no letter headings to split them.
  const grouped = !q && (st.sort === "name" || st.sort === "nameDesc");
  if (q) items = byRelevance(items, q);
  // Each card is its own list; the headings between them stay outside any list.
  const pushGroup = (list: VaultItem[]) => nodes.push(h("div", { class: "group", role: "list" }, ...list.map((i) => itemRow(ctx, i))));
  const browsing = !q && !st.folder;
  const page = st.page?.host && st.folder !== "trash" && !q ? st.page : undefined;
  const shownAbove = new Set<string>();
  // The site's own logins lead, also inside a filter (the ones the filter keeps).
  if (page) {
    const ids = new Set(page.items.filter((i) => i.type === 1).map((i) => i.id));
    const site = items.filter((i) => ids.has(i.id));
    for (const i of site) shownAbove.add(i.id);
    // An empty vault leads with its own empty state: no site heading over nothing.
    if (items.length && (site.length || browsing)) {
      nodes.push(sectionTitle(t("onThisSite", page.host!)));
      if (site.length) nodes.push(h("div", { class: "group", role: "list" }, ...site.map((i) => suggestionRow(ctx, i))));
      if (browsing) nodes.push(h("button", { type: "button", class: "btn text small add-page", onclick: () => void saveFromPage(ctx) }, icon("plus"), t("saveFromPage")));
    }
  }
  if (!items.length) {
    nodes.push(emptyState(ctx, q));
  } else {
    // Favorites next; a letter index is kept for the rest.
    // A favorite already listed for this site above is not listed again.
    const favs = q ? [] : items.filter((i) => i.favorite && !shownAbove.has(i.id));
    const rest = favs.length ? items.filter((i) => !i.favorite) : items;
    if (favs.length) {
      nodes.push(sectionTitle(t("favorites")));
      pushGroup(favs);
      for (const i of favs) shownAbove.add(i.id);
    }
    // Then recently opened items, while browsing a vault big enough to need them; one already shown above is left out.
    if (browsing && items.length > 8 && recentShown()) {
      const opened = loadOpened();
      const recent = items.filter((i) => opened[i.id] && !shownAbove.has(i.id)).sort((a, b) => opened[b.id]!.at - opened[a.id]!.at).slice(0, 3);
      if (recent.length) {
        nodes.push(
          h(
            "div",
            { class: "section-head" },
            sectionTitle(t("recentlyOpened")),
            h("button", { type: "button", class: "btn text small", onclick: () => void clearOpened().then(() => ctx.rerender()) }, t("clear")),
          ),
        );
        pushGroup(recent);
      }
    }
    // Cards and identities to fill on this page belong to no site: headings of their own, like the official client.
    if (page && browsing)
      for (const [type, title] of [[3, "typeCards"], [4, "typeIdentities"]] as const) {
        const list = page.items.filter((i) => i.type === type);
        if (list.length) nodes.push(sectionTitle(t(title)), h("div", { class: "group", role: "list" }, ...list.map((i) => suggestionRow(ctx, i))));
      }
    if (!grouped) {
      if (rest.length) pushGroup(rest);
    } else {
      let letter = "";
      let bucket: VaultItem[] = [];
      const flush = () => {
        if (!bucket.length) return;
        nodes.push(h("h2", { class: "letter" }, letter));
        pushGroup(bucket);
        bucket = [];
      };
      for (const i of rest) {
        const l = /[\p{L}\p{N}]/u.test(i.name[0] ?? "") ? i.name[0]!.toUpperCase() : "#";
        if (l !== letter) {
          flush();
          letter = l;
        }
        bucket.push(i);
      }
      flush();
    }
  }
  box.replaceChildren(...(nodes.filter(Boolean) as Node[]));
}

export function arrowNav(box: HTMLElement) {
  box.addEventListener("keydown", (e) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const rows = [...box.querySelectorAll<HTMLElement>("[role=listitem] > .row-main")];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    // Up from the first row goes back to the search box it came from.
    if (at === 0 && e.key === "ArrowUp") return void document.getElementById("vault-search")?.focus();
    const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : at + (e.key === "ArrowDown" ? 1 : -1);
    rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
  });
}

export let skeletonShown = false;
/** The skeleton while the first list loads; the list that replaces it fades in (popup.css .list-body.enter). */
export function listOrSkeleton(list: HTMLElement): HTMLElement {
  const loading = st.loading && !st.list;
  if (!loading && skeletonShown) list.classList.add("enter");
  skeletonShown = loading;
  return loading ? skeletonList() : list;
}

export function skeletonList(): HTMLElement {
  return h(
    "div",
    { class: "group", "aria-hidden": "true" },
    ...Array.from({ length: 7 }, () =>
      h(
        "div",
        { class: "row skeleton" },
        h("span", { class: "tile skeleton-tile" }),
        h("div", { class: "body" }, h("span", { class: "skeleton-line w40" }), h("span", { class: "skeleton-line w70" })),
      ),
    ),
  );
}

export function listView(ctx: Ctx): HTMLElement {
  if (st.folder === "trash" && st.list && !st.list.trash.length) st.folder = ""; // the trash was emptied
  if (st.folder === "archive" && st.list && !st.list.archive.length) st.folder = ""; // the last item left the archive
  const listBox = h("div", { class: "list-body" });
  arrowNav(listBox);
  const addBtn = iconButton("plus", t("newItem"), () => void newItem(ctx), { class: "icon-btn sm add" });
  const redraw = () => {
    const q = st.query.trim().toLowerCase();
    const source = st.folder === "trash" ? st.list?.trash : st.folder === "archive" ? st.list?.archive : st.list?.items;
    const clauses = parseQuery(st.query);
    const items = sortItems((source ?? []).filter((i) => matches(i, clauses)));
    fillList(ctx, listBox, items, q);
    // The empty vault leads with its own "New item" (emptyState): the header one would say it twice.
    addBtn.hidden = !(st.loading && !st.list) && !items.length && !q && !st.folder; // not under the first-load skeleton
    // Said to screen readers while a search or filter is on: how many items it leaves (polite, so typing is not cut).
    status.textContent = q || st.folder ? (items.length ? plural("itemsFound", items.length) : t("noMatches")) : "";
  };
  const status = h("p", { class: "sr-only", role: "status" });
  redraw();

  const input = h("input", {
    id: "vault-search",
    type: "search",
    placeholder: t("searchVault"),
    "aria-label": t("searchVault"),
    "aria-keyshortcuts": "/",
    title: t("searchHint"),
    value: st.query,
    ...(st.sawList ? {} : { "data-autofocus": "1" }),
    oninput: (e: Event) => {
      st.query = (e.target as HTMLInputElement).value;
      clearBtn.hidden = !st.query;
      redraw(); // list only, so the search box keeps focus and caret
    },
    onkeydown: (e: KeyboardEvent) => {
      // ArrowDown steps into the results; Enter opens the first one.
      const first = document.querySelector<HTMLElement>(".list-body [role=listitem] > .row-main");
      if ((e.key === "ArrowDown" || e.key === "Enter") && first && !e.isComposing) {
        e.preventDefault();
        if (e.key === "Enter") first.click();
        else first.focus();
        return;
      }
      if (e.key === "Escape" && st.query) {
        e.stopPropagation();
        st.query = "";
        input.value = "";
        clearBtn.hidden = true;
        redraw();
      }
    },
  });
  st.sawList = true;
  const clearBtn = h(
    "button",
    {
      type: "button",
      class: "icon-btn sm",
      "aria-label": t("clearSearch"),
      title: t("clearSearch"),
      hidden: !st.query,
      onclick: () => {
        st.query = "";
        input.value = "";
        clearBtn.hidden = true;
        redraw();
        input.focus();
      },
    },
    icon("close"),
  );

  const sortButton = iconButton("sort", t("sort"), () => {}, { class: "icon-btn sm", "aria-haspopup": "menu" });
  sortButton.onclick = () =>
    menu(
      sortButton,
      t("sort"),
      SORTS.map((s) => ({
        label: t(s.label),
        checked: st.sort === s.id,
        onClick: () => {
          st.sort = s.id;
          try {
            localStorage.setItem(SORT_KEY, s.id);
          } catch {
            /* no storage */
          }
          ctx.rerender();
        },
      })),
      true,
    );

  const folders = st.list?.folders ?? [];
  const chip = (id: string, label: string, ic?: IconName) =>
    h(
      "button",
      {
        type: "button",
        class: "chip",
        id: `chip-${id}`,
        "aria-pressed": String(st.folder === id),
        onclick: () => {
          st.folder = st.folder === id ? "" : id;
          ctx.rerender();
        },
      },
      ic ? icon(ic) : null,
      label,
    );

  return h(
    "div",
    { class: "page list-page" },
    topBar(
      h("div", { class: "search" }, icon("search"), input, clearBtn),
      sortButton,
      iconButton("refresh", t("syncNow"), () => void syncNow(ctx, true), { id: "vault-sync", class: `icon-btn sm${st.syncing ? " spin" : ""}`, disabled: st.syncing }),
      iconButton("lock", t("lockNow"), () => ctx.lock(), { class: "icon-btn sm" }),
      addBtn,
    ),
    chipRow(
      // Filters over an empty vault could only ever say "no matches".
      { role: "group", "aria-label": t("filters"), hidden: st.list?.items.length === 0 && !st.list.trash.length && !st.list.archive.length },
      chip("fav", t("favorites"), "starBorder"), // outline, like the other chips' glyphs
      chip("t:1", t("typeLogin"), "key"),
      chip("t:3", t("typeCard"), "card"),
      chip("t:4", t("typeIdentity"), "user"),
      chip("t:2", t("typeNote"), "note"),
      ...([[6, "landmark"], [7, "card"], [8, "globe"]] as const).map(([type, ic]) => (st.list?.items.some((i) => i.type === type) ? chip(`t:${type}`, t(TYPE_LABEL[type]!), ic) : null)),
      st.list?.items.some((i) => i.reused) ? chip("reused", t("filterReused"), "error") : null,
      st.list?.items.some((i) => i.weak) ? chip("weak", t("filterWeak"), "error") : null,
      ...folders.map((f) => chip(f.id, f.name, "folder")),
      folders.length ? chip("none", t("noFolder"), "folder") : null,
      st.list?.archive.length ? chip("archive", t("archiveCount", String(st.list.archive.length)), "archive") : null,
      st.list?.trash.length ? chip("trash", t("trashCount", String(st.list.trash.length)), "trash") : null,
      h("button", { type: "button", class: "chip", onclick: () => open(ctx, { kind: "report" }) }, icon("shield"), t("securityReport")),
      h("button", { type: "button", class: "chip", onclick: () => open(ctx, { kind: "folders" }) }, icon("edit"), t("folders")),
    ),
    errorBox(),
    !st.attentionHidden && uiPref("attentionBanner") === "on" && !st.query && !st.folder && st.list?.items.some((i) => i.reused || i.weak)
      ? h(
          "div",
          { class: "notice warn", role: "region", "aria-label": t("securityReport") },
          icon("error"),
          h(
            "div",
            {},
            h("strong", {}, t("attentionTitle", String(st.list.items.filter((i) => i.reused || i.weak).length))),
            h("p", { class: "caption" }, t("attentionBody")),
            h(
              "div",
              { class: "row-actions" },
              h("button", { type: "button", class: "btn tonal small", onclick: () => open(ctx, { kind: "report" }) }, t("attentionReview")),
              h("button", { type: "button", class: "btn text small", onclick: () => ((st.attentionHidden = true), ctx.rerender()) }, t("defaultAskLater")),
              // For good; Settings → "Weak and reused password banner" brings it back.
              h("button", { type: "button", class: "btn text small", onclick: () => (setUiPref("attentionBanner", "off"), ctx.rerender()) }, t("attentionNever")),
            ),
          ),
        )
      : null,
    ctx.settings() && !ctx.settings()!.defaultManager && uiPref("defaultAsked") !== "yes" && st.list?.items.length
      ? h(
          "div",
          { class: "notice", role: "region", "aria-label": t("defaultAskTitle") },
          icon("shield"),
          h(
            "div",
            {},
            h("strong", {}, t("defaultAskTitle")),
            h("p", { class: "caption" }, t("defaultAskBody")),
            h(
              "div",
              { class: "row-actions" },
              h("button", { type: "button", class: "btn tonal small", onclick: () => ctx.goto("settings", t("defaultManager")) }, t("defaultAskOpen")),
              h("button", { type: "button", class: "btn text small", onclick: () => (setUiPref("defaultAsked", "yes"), ctx.rerender()) }, t("defaultAskLater")),
            ),
          ),
        )
      : null,
    status,
    listOrSkeleton(listBox),
  );
}

// ---------- this site ----------

export async function fill(ctx: Ctx, id: string, anyway = false, page = st.page) {
  // Bound to the page shown here: the worker refuses once the tab or its site changed, also after the dialog.
  const { tabId, origin, host } = page ?? {};
  if (tabId === undefined || !origin) return toast(ctx, t("fillFailed"), { error: true });
  const r = await send<FillResult>({ type: "fill", id, tabId, origin, anyway });
  if (r.ok && r.data.filled) window.close();
  // A flagged item: its view shows the master-password screen (itemView gets "reprompt" from getItem).
  else if (!r.ok && r.code === "reprompt") open(ctx, { kind: "item", id });
  // A login saved for another site: fill only after the user says so, like the official client.
  else if (r.ok && r.data.reason === "noMatch" && !anyway && host && (await confirmFill(host))) await fill(ctx, id, true, page);
  else {
    toast(ctx, r.ok ? t("fillFailed") : r.error, { error: true });
    // Show the site the browser is on now, so the next click is for the page the user sees.
    if (!r.ok) await refreshPageMatches(true).then(() => ctx.rerender());
  }
}

export function confirmFill(host: string): Promise<boolean> {
  const choose = (v: string) => () => d.close(v);
  const d = h(
    "dialog",
    { class: "confirm", "aria-labelledby": "confirm-fill-text" },
    h("p", { id: "confirm-fill-text" }, t("fillNoMatch", host)),
    h(
      "div",
      { class: "actions" },
      h("button", { type: "button", class: "btn text", onclick: choose("") }, t("cancel")),
      h("button", { type: "button", class: "btn filled", onclick: choose("fill") }, t("fillAnyway")),
    ),
  );
  document.body.append(d);
  d.showModal();
  return new Promise((resolve) => d.addEventListener("close", () => (d.remove(), resolve(d.returnValue === "fill"))));
}

export const fillButton = (ctx: Ctx, i: VaultItem) =>
  h("button", { type: "button", class: "btn small tonal", "aria-label": t("fillNamed", i.name), onclick: () => void fill(ctx, i.id) }, t("fill"));

/** Save what the user typed on the page: update the login with the same username, or create one. */
export async function saveFromPage(ctx: Ctx) {
  const page = st.page;
  if (page?.tabId === undefined || !page.origin) return toast(ctx, t("noLoginOnPage"), { error: true });
  // The page the site section shows, so the logins compared below are that site's.
  const r = await send<PageLogin | null>({ type: "readPageLogin", tabId: page.tabId, origin: page.origin });
  if (!r.ok || !r.data) return toast(ctx, r.ok ? t("noLoginOnPage") : r.error, { error: true });
  const login = r.data;
  const same = page.items.find((i) => i.type === 1 && !i.readOnly && i.sub === login.username);
  if (same) {
    const item = await send<Json>({ type: "getItem", id: same.id });
    if (item.ok) return startEdit(ctx, item.data, { data: { password: login.password } });
    if (item.code === "reprompt") return open(ctx, { kind: "item", id: same.id }); // never fall through to a duplicate
  }
  startEdit(ctx, undefined, { ...sitePrefill(new URL(login.url).origin), data: { username: login.username, password: login.password } });
}

/** A row of the site section: the body opens the item, the button fills it (cards and identities too). */
export function suggestionRow(ctx: Ctx, i: VaultItem): HTMLElement {
  const name = i.name || t("untitled");
  return h(
    "div",
    // A list item like the vault rows, so the arrow keys and Enter from the search reach the site's matches first.
    { class: "row", role: "listitem" },
    h(
      "button",
      { type: "button", class: "row-main", "data-item": i.id, "aria-label": rowLabel(i, name), onclick: () => open(ctx, { kind: "item", id: i.id }) },
      tile(i.name, i.type, i.uris, i.brand),
      h("div", { class: "body" }, h("span", { class: "title" }, name), i.sub ? h("span", { class: "sub" }, i.sub) : null),
      ...rowMarks(i),
    ),
    ...rowActions(ctx, i),
    fillButton(ctx, i),
  );
}
