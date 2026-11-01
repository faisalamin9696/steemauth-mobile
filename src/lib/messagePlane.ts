/**
 * Relay plane client (protocol v3) — the app side of steemauth-relay.
 *
 * Join the QR's room with the PHONE token, pull the backlog (replay heals
 * backgrounding, process death and network handoffs), then stream live
 * frames. Envelopes are `{ c, m }` — AES + HMAC verified by `openMessage`
 * in the caller; this module only moves opaque blobs.
 *
 * Durability contract (mirrors the relay):
 *   - `cursor` = highest seq delivered; rejoin + `pull { cursor }` after any
 *     drop, so nothing is lost while the app was away;
 *   - auto-reconnect with backoff (3 attempts), then `failed` for the UI;
 *   - `send()` waits for the relay's ack — a lost message is visible as a
 *     typed rejection, never silent.
 *
 * Security posture: the token rides the TLS socket only; the relay stores
 * just its sha256 hash; malformed frames are dropped before any crypto.
 */
export type RelayPlaneStatus = "connecting" | "connected" | "failed";

export interface RelayPlaneOptions {
  /** Relay URL from the QR (`rt`). */
  rt: string;
  /** Room name from the QR (`rm`). */
  rm: string;
  /** The PHONE's room token from the QR (`tk`). */
  tk: string;
  /** Session id — used only for diagnostics. */
  sid: string;
  /** Raw envelope delivered by a peer — verify with `openMessage`. */
  onMessage(payload: unknown): void;
  onStatus?(status: RelayPlaneStatus): void;
}

export interface RelayPlane {
  /** Append one sealed envelope to the room log. Throws typed errors. */
  send(payload: unknown): Promise<void>;
  /** Stop listening (the log lives on until the relay sweeps the room). */
  close(): void;
  readonly cursor: number;
}

const MAC_RE = /^[0-9a-f]{64}$/;
const MAX_ENVELOPE_BYTES = 64 * 1024;

function isEnvelope(payload: unknown): payload is { c: string; m: string } {
  if (!payload || typeof payload !== "object") return false;
  const keys = Object.keys(payload);
  const { c, m } = payload as { c?: unknown; m?: unknown };
  return (
    keys.length > 0 &&
    keys.every((k) => k === "c" || k === "m") &&
    typeof c === "string" &&
    typeof m === "string" &&
    MAC_RE.test(m) &&
    c.length <= MAX_ENVELOPE_BYTES
  );
}

export function connectMessagePlane(opts: RelayPlaneOptions): RelayPlane {
  const { rt, rm, tk, sid, onMessage, onStatus } = opts;

  let ws: WebSocket | null = null;
  let cursor = 0;
  let closed = false;
  let connected = false;
  let attempts = 0;
  let handshake: { resolve: () => void; reject: (e: Error) => void } | null = null;
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const outbox: {
    resolve: () => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];

  const status = (s: RelayPlaneStatus) => onStatus?.(s);

  const failHandshake = (e: Error) => {
    if (handshakeTimer) clearTimeout(handshakeTimer);
    handshakeTimer = null;
    const w = handshake;
    handshake = null;
    w?.reject(e);
  };

  const resolveSend = () => {
    const w = outbox.shift();
    if (!w) return;
    clearTimeout(w.timer);
    w.resolve();
  };
  const rejectSend = (e: Error) => {
    const w = outbox.shift();
    if (!w) return;
    clearTimeout(w.timer);
    w.reject(e);
  };

  const deliver = (rows: [number, unknown][]) => {
    for (const [seq, payload] of rows) {
      if (!Number.isInteger(seq) || seq <= cursor) continue; // replay ∩ live dedup
      cursor = seq;
      try {
        onMessage(payload);
      } catch {
        // a throwing receiver must not stall the stream
      }
    }
  };

  const attach = (w: { resolve: () => void; reject: (e: Error) => void }) => {
    const sock = new WebSocket(rt);
    ws = sock;
    status("connecting");

    handshakeTimer = setTimeout(() => {
      failHandshake(new Error("Timed out joining the relay room"));
      try {
        sock.close();
      } catch {
        /* ignore */
      }
    }, 10_000);

    sock.onopen = () => {
      if (closed) return;
      sock.send(JSON.stringify({ t: "join", room: rm, tok: tk }));
    };

    sock.onmessage = (ev) => {
      if (closed) return;
      let frame: {
        t?: string;
        code?: string;
        cursor?: number;
        rows?: [number, unknown][];
        seq?: number;
        payload?: unknown;
      };
      try {
        frame = JSON.parse(String((ev as MessageEvent).data));
      } catch {
        return;
      }
      switch (frame.t) {
        case "ok": {
          if (typeof frame.cursor === "number") cursor = Math.max(cursor, frame.cursor);
          if (handshake) sock.send(JSON.stringify({ t: "pull", cursor }));
          break;
        }
        case "rows": {
          deliver(frame.rows ?? []);
          if (handshake) {
            const done = handshake;
            handshake = null;
            if (handshakeTimer) clearTimeout(handshakeTimer);
            handshakeTimer = null;
            connected = true;
            attempts = 0;
            status("connected");
            done.resolve();
          }
          break;
        }
        case "msg": {
          if (typeof frame.seq === "number") deliver([[frame.seq, frame.payload]]);
          break;
        }
        case "ack": {
          if (typeof frame.seq === "number") cursor = Math.max(cursor, frame.seq);
          resolveSend();
          break;
        }
        case "err": {
          if (handshake) {
            failHandshake(new Error(`Relay refused the session (${frame.code})`));
          } else {
            rejectSend(new Error(`Relay refused a message (${frame.code})`));
          }
          break;
        }
        default:
          break;
      }
    };

    const onDown = () => {
      if (closed) return;
      connected = false;
      ws = null;
      while (outbox.length) rejectSend(new Error("Connection to the relay dropped mid-send"));
      if (handshake) failHandshake(new Error("Relay connection dropped during handshake"));
      if (attempts >= 3) {
        status("failed");
        return;
      }
      const delay = 400 * 2 ** attempts;
      attempts += 1;
      status("connecting");
      reconnectTimer = setTimeout(() => {
        if (closed) return;
        try {
          attach({ resolve: () => {}, reject: () => {} });
        } catch {
          status("failed");
        }
      }, delay);
    };
    sock.onclose = onDown;
    sock.onerror = () => {
      /* onclose follows and drives recovery */
    };
  };

  const ready = new Promise<void>((resolve, reject) => {
    handshake = { resolve, reject };
    try {
      attach(handshake);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
  // Status consumers observe failures via onStatus; never crash the app on
  // an unhandled rejection from the handshake promise.
  ready.catch((e) => {
    console.warn("[steemauth] relay plane handshake failed:", sid, e instanceof Error ? e.message : e);
  });

  return {
    get cursor() {
      return cursor;
    },
    async send(payload: unknown): Promise<void> {
      if (closed) throw new Error("relay plane closed");
      if (!isEnvelope(payload)) throw new Error("malformed envelope");
      await ready; // never send before the first pull completed
      if (!connected || !ws || ws.readyState !== 1) {
        throw new Error("relay plane not connected");
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = outbox.indexOf(waiter);
          if (i >= 0) outbox.splice(i, 1);
          reject(new Error("Relay did not acknowledge a message in time"));
        }, 10_000);
        const waiter = { resolve, reject, timer };
        outbox.push(waiter);
        try {
          ws!.send(JSON.stringify({ t: "msg", payload }));
        } catch (e) {
          const i = outbox.indexOf(waiter);
          if (i >= 0) outbox.splice(i, 1);
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (handshakeTimer) clearTimeout(handshakeTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      failHandshake(new Error("relay plane closed"));
      while (outbox.length) rejectSend(new Error("relay plane closed"));
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      ws = null;
    },
  };
}
