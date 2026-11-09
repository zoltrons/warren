/** SHA-256 hex of a copied text, to recognise it on the clipboard later without keeping it. Line ends as a textarea reads them back. */
export const clipboardDigest = async (text: string): Promise<string> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text.replace(/\r\n?/g, "\n")))).toHex();
