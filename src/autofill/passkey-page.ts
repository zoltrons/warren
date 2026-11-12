// Page (MAIN world) shim, registered on every secure origin (https, localhost). Routes ES256
// public-key navigator.credentials.create/get calls to Warren through the isolated relay
// (passkey-relay.ts) and falls back to the browser's own handling whenever Warren declines.
// Conditional mediation (passkey autofill) is raced against the browser's native conditional UI:
// whichever answers first wins, and Warren's side also drives the inline menu entry.
// Not handled (browser handles them): non-ES256 algorithms.
(() => {
  const c = navigator.credentials;
  if (!c || !window.PublicKeyCredential) return;
  const create = c.create.bind(c);
  const get = c.get.bind(c);
  // Like the official clients: when the browser reports no built-in authenticator, advertise one so
  // sites still offer passkey creation and passkey autofill (Warren answers both).
  const pkc = window.PublicKeyCredential as unknown as Record<string, unknown>;
  for (const name of ["isUserVerifyingPlatformAuthenticatorAvailable", "isConditionalMediationAvailable"]) {
    const fn = pkc[name];
    if (typeof fn !== "function") continue;
    Promise.resolve((fn as () => Promise<boolean>).call(pkc)).then(
      (available) => {
        if (available) return;
        try {
          pkc[name] = () => Promise.resolve(true);
        } catch {
          // Read-only in this browser: leave its answer alone.
        }
      },
      () => undefined,
    );
  }
  // Sites newer than those two functions ask getClientCapabilities() (WebAuthn L3) before offering passkeys: report what
  // Warren adds on top of the browser's answer. Nothing it does not do (relatedOrigins, prf).
  const capabilities = pkc.getClientCapabilities;
  if (typeof capabilities === "function") {
    try {
      pkc.getClientCapabilities = async () => {
        const native = ((await Promise.resolve((capabilities as () => Promise<Record<string, boolean>>).call(pkc)).catch(() => ({}))) ?? {}) as Record<string, boolean>;
        const all: Record<string, boolean> = { ...native, conditionalCreate: true, conditionalGet: true, "extension:credProps": true, passkeyPlatformAuthenticator: true, userVerifyingPlatformAuthenticator: true };
        return Object.fromEntries(Object.entries(all).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))); // keys sorted, as WebAuthn has them
      };
    } catch {
      // Read-only in this browser: leave its answer alone.
    }
  }
  const b64u = (b: BufferSource) =>
    (ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b)).toBase64({ alphabet: "base64url", omitPadding: true });
  const buf = (s: string) => Uint8Array.fromBase64(s, { alphabet: "base64url" }).buffer;
  let next = 0;

  type Result = { credential: Record<string, any> } | { fallback: true } | { error: { name: string; message: string } };
  type Answer = { id: string; result: Result };

  /**
   * One call over the relay. `signal` mirrors the page's AbortSignal: aborting drops the pending
   * request in the service worker (and closes its approval window).
   */
  const ask = (kind: "create" | "get", options: unknown, conditional: boolean, signal?: AbortSignal | null) =>
    new Promise<Answer>((resolve, reject) => {
      const id = `${Date.now()}-${++next}`;
      const finish = (fn: () => void) => {
        removeEventListener("message", on);
        signal?.removeEventListener("abort", abort);
        fn();
      };
      const on = (ev: MessageEvent) => {
        if (ev.source !== window || ev.data?.warren !== "res" || ev.data.id !== id) return;
        finish(() => resolve({ id, result: ev.data.result as Result }));
      };
      const abort = () => {
        postMessage({ warren: "abort", id }, "*");
        finish(() => reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError")));
      };
      if (signal?.aborted) return abort();
      addEventListener("message", on);
      signal?.addEventListener("abort", abort, { once: true });
      postMessage({ warren: "req", id, kind, conditional, options }, "*");
    });

  // Plain objects with the right prototypes: own data properties shadow the native getters.
  function credential(r: Record<string, any>, kind: "create" | "get"): PublicKeyCredential {
    const response =
      kind === "create"
        ? {
            clientDataJSON: buf(r.clientDataJSON),
            attestationObject: buf(r.attestationObject),
            getAuthenticatorData: () => buf(r.authenticatorData),
            getPublicKey: () => buf(r.publicKey),
            getPublicKeyAlgorithm: () => r.publicKeyAlgorithm,
            getTransports: () => r.transports,
          }
        : {
            clientDataJSON: buf(r.clientDataJSON),
            authenticatorData: buf(r.authenticatorData),
            signature: buf(r.signature),
            userHandle: r.userHandle ? buf(r.userHandle) : null,
          };
    Object.setPrototypeOf(response, (kind === "create" ? AuthenticatorAttestationResponse : AuthenticatorAssertionResponse).prototype);
    const { id, credProps, ...json } = r;
    const extensions = kind === "create" && credProps ? { credProps } : {};
    const cred = {
      id,
      rawId: buf(id),
      type: "public-key",
      authenticatorAttachment: "platform",
      response,
      getClientExtensionResults: () => extensions,
      toJSON: () => ({ id, rawId: id, type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: extensions, response: json }),
    };
    Object.setPrototypeOf(cred, PublicKeyCredential.prototype);
    return cred as unknown as PublicKeyCredential;
  }

  const options = (pk: PublicKeyCredentialRequestOptions) => ({
    rpId: pk.rpId,
    challenge: b64u(pk.challenge),
    allow: (pk.allowCredentials ?? []).map((x) => b64u(x.id)),
    userVerification: pk.userVerification ?? "preferred",
  });

  /**
   * The browser refuses WebAuthn from an unfocused document. After Warren's window closes ("use another device"),
   * focus comes back a moment later: wait for it, bounded, before handing the call over.
   */
  const refocused = () =>
    document.hasFocus()
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            removeEventListener("focus", done);
            resolve();
          };
          const timer = setTimeout(done, 120_000);
          addEventListener("focus", done);
        });

  const settle = async (kind: "create" | "get", opts: unknown, fallback: () => Promise<Credential | null>, signal?: AbortSignal | null, conditional = false) => {
    const { result } = await ask(kind, opts, conditional, signal);
    if ("credential" in result) return credential(result.credential, kind);
    if ("error" in result) throw new DOMException(result.error.message, result.error.name);
    await refocused();
    return fallback();
  };

  /** Conditional mediation: the browser's own passkey UI and Warren's inline menu compete. */
  const conditionalGet = async (opts: CredentialRequestOptions, pk: PublicKeyCredentialRequestOptions) => {
    const aborted = () => opts.signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
    if (opts.signal?.aborted) throw aborted();
    const mine = new AbortController();
    const native = new AbortController();
    const stop = () => {
      native.abort();
      mine.abort(); // drops Warren's pending request (and its inline-menu entry)
    };
    const nativeCall = get({ ...opts, signal: native.signal });
    const answer = ask("get", options(pk), true, mine.signal);
    return await new Promise<Credential | null>((resolve, reject) => {
      const onAbort = () => {
        stop();
        reject(aborted());
      };
      const done = () => opts.signal?.removeEventListener("abort", onAbort);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      nativeCall.then(
        (cred) => {
          // The browser's UI answered: drop Warren's pending request and its menu entry.
          if (!cred) return;
          stop();
          done();
          resolve(cred);
        },
        () => undefined, // browser UI dismissed or Warren answered first
      );
      answer.then(
        ({ result }) => {
          if ("credential" in result) {
            stop();
            done();
            resolve(credential(result.credential, "get"));
          } else if ("error" in result) {
            stop();
            done();
            reject(new DOMException(result.error.message, result.error.name));
          }
          // fallback: keep waiting for the browser's own UI (and for its AbortSignal)
        },
        (e: unknown) => {
          stop();
          done();
          reject(e);
        },
      );
    });
  };

  c.create = (opts?: CredentialCreationOptions) => {
    const pk = opts?.publicKey;
    // Conditional create (an automatic passkey upgrade after a password sign-in) opens nothing: Warren saves it only
    // right after it filled that sign-in, and otherwise refuses, as WebAuthn has it.
    const conditional = (opts as { mediation?: string } | undefined)?.mediation === "conditional";
    // An unfocused document is the browser's to refuse: it must not open (and focus) our window.
    if (!pk || !pk.pubKeyCredParams.some((p) => p.alg === -7) || (!conditional && !document.hasFocus())) return create(opts);
    return settle(
      "create",
      {
        rpId: pk.rp.id,
        rpName: pk.rp.name,
        user: { id: b64u(pk.user.id), name: pk.user.name, displayName: pk.user.displayName },
        challenge: b64u(pk.challenge),
        exclude: (pk.excludeCredentials ?? []).map((x) => b64u(x.id)),
        discoverable: pk.authenticatorSelection?.residentKey !== "discouraged",
        userVerification: pk.authenticatorSelection?.userVerification ?? "preferred",
      },
      () => create(opts),
      opts.signal,
      conditional,
    );
  };

  /** Every allowed credential lives on a security key (USB, NFC, BLE): Warren holds none of them. */
  const securityKeysOnly = (pk: PublicKeyCredentialRequestOptions) =>
    !!pk.allowCredentials?.length && pk.allowCredentials.every((x) => x.transports?.length && !x.transports.includes("internal"));

  c.get = (opts?: CredentialRequestOptions) => {
    const pk = opts?.publicKey;
    if (!pk || securityKeysOnly(pk)) return get(opts);
    if (opts.mediation === "conditional") return conditionalGet(opts, pk);
    if (!document.hasFocus()) return get(opts);
    return settle("get", options(pk), () => get(opts), opts.signal);
  };
})();
