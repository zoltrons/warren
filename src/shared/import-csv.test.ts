import assert from "node:assert/strict";
import { test } from "node:test";
import { csvToExport } from "./csv.ts";

const login = (i: Record<string, unknown>) => i.login as Record<string, unknown>;

test("Chrome / Edge / Brave: name, url, username, password, note", () => {
  const r = csvToExport("name,url,username,password,note\nGitHub,https://github.com/login,octo,pw1,my note\n");
  assert.equal(r.items.length, 1);
  assert.deepEqual([r.items[0]!.name, r.items[0]!.notes, login(r.items[0]!).username, login(r.items[0]!).password], ["GitHub", "my note", "octo", "pw1"]);
  assert.deepEqual(login(r.items[0]!).uris, [{ uri: "https://github.com/login", match: null }]);
});

test("Firefox: no title column, the host names the item", () => {
  const r = csvToExport('"url","username","password","httpRealm","formActionOrigin","guid"\n"https://example.org","u","p","","https://example.org","{1}"\n');
  assert.equal(r.items[0]!.name, "example.org");
});

test("LastPass: http://sn is a secure note, grouping becomes a folder, fav a favorite", () => {
  const r = csvToExport("url,username,password,totp,extra,name,grouping,fav\nhttp://sn,,,,wifi code 42,Wifi,Home,1\nhttps://a.test,me,pw,,,A,Home,0\n");
  assert.equal(r.items[0]!.type, 2);
  assert.equal(r.items[0]!.notes, "wifi code 42");
  assert.equal(r.items[0]!.favorite, true);
  assert.equal(r.items[1]!.type, 1);
  assert.deepEqual(r.folders, [{ id: "0", name: "Home" }]);
  assert.equal(r.items[1]!.folderId, "0");
});

test("KeePassXC and Keeper layouts", () => {
  const kp = csvToExport("Group,Title,Username,Password,URL,Notes,TOTP\nWork,Mail,me,pw,https://mail.test,n,JBSWY3DPEHPK3PXP\n");
  assert.equal(login(kp.items[0]!).totp, "JBSWY3DPEHPK3PXP");
  assert.deepEqual(kp.folders, [{ id: "0", name: "Work" }]);
  const kp2 = csvToExport("Folder,Title,Login,Password,Website Address,Notes\nBank,Acme,me2,pw2,https://acme.test,\n");
  assert.deepEqual([kp2.items[0]!.name, login(kp2.items[0]!).username, login(kp2.items[0]!).password], ["Acme", "me2", "pw2"]);
});

test("Proton Pass: a file with type and name but no login_* column is not Bitwarden's; notes become notes", () => {
  const r = csvToExport("type,name,url,email,username,password,note,totp,vault\nlogin,Site,https://s.test,a@b.test,,pw,,,Personal\nnote,Memo,,,,,remember,,Personal\ncreditCard,Visa,,,,,,,Personal\n");
  assert.equal(r.items.length, 2);
  assert.equal(login(r.items[0]!).username, "a@b.test");
  assert.equal(r.items[1]!.type, 2);
});

test("a Bitwarden CSV still goes through the Bitwarden reader", () => {
  const r = csvToExport("folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,1,login,X,,,0,https://x.test,u,p,\n");
  assert.equal(r.items[0]!.favorite, true);
});

test("a CSV without a password column is refused, empty rows are skipped", () => {
  assert.throws(() => csvToExport("a,b\n1,2\n"), /not an export Warren knows/);
  assert.equal(csvToExport("name,url,username,password\n,,,\nA,https://a.test,u,p\n").items.length, 1);
});
