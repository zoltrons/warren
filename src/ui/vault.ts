// The vault tab: picks the screen for the current route. The screens live in vault-list.ts (list, search, quick
// actions), vault-item.ts (item view), vault-edit.ts (editor), vault-tools.ts (folders, organizations, security
// report); vault-shared.ts holds their state and helpers. The generator is generator.ts.
// Talks to the service worker only; decrypted data lives here just while the popup is open.
import { generatorScreen } from "./generator.ts";
import { type Ctx, st, setCurrentCtx, closeMenu, loadList } from "./vault-shared.ts";
import { listView } from "./vault-list.ts";
import { qrView, largeTypeView, itemView } from "./vault-item.ts";
import { editView } from "./vault-edit.ts";
import { orgView, reportView, foldersView } from "./vault-tools.ts";

export function vaultScreen(ctx: Ctx): HTMLElement {
  setCurrentCtx(ctx);
  closeMenu(); // a re-render invalidates any open popover menu
  if (!st.list && !st.loading && !st.error) void loadList(ctx);
  const r = st.route;
  if (st.large) return largeTypeView(ctx);
  if (st.qr) return qrView(ctx);
  if (r.kind === "item") return itemView(ctx, r.id);
  if (r.kind === "edit" && st.draft && st.picking) {
    const field = st.picking;
    const d = st.draft;
    const back = () => {
      st.picking = undefined;
      ctx.rerender();
    };
    return generatorScreen(ctx, {
      field,
      back,
      use: (value) => {
        d.data[field] = value;
        if (field === "password") st.reveal.add("edit-password");
        back();
      },
      ...(field === "username"
        ? {
            addField: (name: string, value: string) => {
              d.fields.push({ name, value, type: 0 });
              back();
            },
          }
        : {}),
    });
  }
  if (r.kind === "edit" && st.draft) return editView(ctx, r.isNew);
  if (r.kind === "folders") return foldersView(ctx);
  if (r.kind === "report") return reportView(ctx);
  if (r.kind === "org") return orgView(ctx, r.id);
  return listView(ctx);
}
