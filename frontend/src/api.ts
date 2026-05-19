import type {
  ActivitySnapshot,
  ChatArtifact,
  ChatMessage,
  Channel,
  Draft,
  Message,
  Summary,
} from "./types";

async function jsonOrThrow<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

/** True for the classic "fetch couldn't even reach the server" errors —
 *  ECONNREFUSED, DNS failure, proxy down, etc. These are transient during
 *  uvicorn --reload restarts, so retrying once usually succeeds. */
function isConnectionError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    msg.includes("failed to fetch") ||
    msg.includes("econnrefused") ||
    msg.includes("network") ||
    msg.includes("load failed")
  );
}

/** fetch() with a single retry on connection-level failures (server restart window). */
async function fetchResilient(url: string, init: RequestInit, retryDelayMs = 1500): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (init.signal?.aborted) throw e;
    if (!isConnectionError(e)) throw e;
    await new Promise((r) => setTimeout(r, retryDelayMs));
    return await fetch(url, init);  // one retry; let any subsequent error bubble
  }
}

export interface SummaryStreamHandlers {
  onMeta?: (m: { channel_id: string; message_count: number }) => void;
  onChunk: (text: string) => void;
  onDone?: () => void;
  onError?: (err: string) => void;
}

export interface DraftPipelineHandlers {
  onPhase?: (phase: "summary" | "draft") => void;
  onSummaryChunk?: (text: string) => void;
  onDraftChunk: (text: string) => void;
  onSaved?: (id: number, body: string) => void;
  onDone?: () => void;
  onError?: (err: string) => void;
}

/**
 * Helper: parses a Server-Sent Events stream returned by fetch().
 * Calls onEvent(eventName, data) for each "event:/data:" frame.
 * (Used for POST endpoints — EventSource only supports GET.)
 */
async function consumeSSE(
  resp: Response,
  onEvent: (event: string, data: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!resp.body) return;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    if (signal?.aborted) { reader.cancel().catch(() => {}); return; }
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      onEvent(event, dataLines.join("\n"));
    }
  }
}

export const api = {
  channels: () => fetch("/slack/channels").then(jsonOrThrow<Channel[]>),
  messages: (channelPk: number, limit = 50) =>
    fetch(`/slack/channels/${channelPk}/messages?limit=${limit}`).then(jsonOrThrow<Message[]>),
  summarize: (channelPk: number, limit = 50) =>
    fetch(`/slack/channels/${channelPk}/summary?limit=${limit}`, { method: "POST" }).then(
      jsonOrThrow<Summary>,
    ),
  syncNow: () => fetch("/slack/sync", { method: "POST" }).then(jsonOrThrow<{ new_messages: number }>),

  summarizeStream(channelPk: number, handlers: SummaryStreamHandlers, limit = 50): EventSource {
    const es = new EventSource(`/slack/channels/${channelPk}/summary/stream?limit=${limit}`);
    es.addEventListener("meta", (e) => {
      try { handlers.onMeta?.(JSON.parse((e as MessageEvent).data)); } catch {}
    });
    es.addEventListener("chunk", (e) => {
      try {
        const { text } = JSON.parse((e as MessageEvent).data);
        if (typeof text === "string") handlers.onChunk(text);
      } catch {}
    });
    es.addEventListener("done", () => {
      handlers.onDone?.();
      es.close();
    });
    es.addEventListener("error", (e) => {
      let msg = "stream error";
      try {
        const data = (e as MessageEvent).data;
        if (data) msg = JSON.parse(data).error ?? msg;
      } catch {}
      handlers.onError?.(msg);
      es.close();
    });
    return es;
  },

  // ---------- Drafts ----------

  drafts(channelPk?: number) {
    const q = channelPk != null ? `?channel_pk=${channelPk}` : "";
    return fetch(`/drafts${q}`).then(jsonOrThrow<Draft[]>);
  },

  createDraft(channelPk: number, body: string, scheduledFor?: string) {
    return fetch("/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel_pk: channelPk, body, scheduled_for: scheduledFor ?? null }),
    }).then(jsonOrThrow<Draft>);
  },

  updateDraft(
    draftId: number,
    patch: { body?: string; scheduled_for?: string | null; unschedule?: boolean },
  ) {
    return fetch(`/drafts/${draftId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then(jsonOrThrow<Draft>);
  },

  sendDraft(draftId: number) {
    return fetch(`/drafts/${draftId}/send`, { method: "POST" }).then(jsonOrThrow<Draft>);
  },

  refineDraft(draftId: number, instruction: string) {
    return fetch(`/drafts/${draftId}/refine`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction }),
    }).then(jsonOrThrow<Draft>);
  },

  deleteDraft(draftId: number) {
    return fetch(`/drafts/${draftId}`, { method: "DELETE" });
  },

  quickSend(channelPk: number, body: string) {
    return fetch("/drafts/quick-send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel_pk: channelPk, body }),
    }).then(jsonOrThrow<{ ok: boolean; ts: string }>);
  },

  // ---------- Assistant ----------

  activity: () => fetch("/assistant/activity").then(jsonOrThrow<ActivitySnapshot>),

  assistantChat(
    message: string,
    history: ChatMessage[],
    handlers: {
      onToken: (text: string) => void;
      onToolStart?: (ev: { id: string; name: string; input?: unknown }) => void;
      onToolEnd?: (ev: { id: string; name: string; output: string }) => void;
      onArtifact?: (a: ChatArtifact) => void;
      onInfo?: (msg: string) => void;
      onDone?: () => void;
      onError?: (err: string) => void;
    },
  ): AbortController {
    const ctrl = new AbortController();
    // Strip frontend-only fields before sending
    const cleanHistory = history.map((m) => ({
      role: m.role,
      content: m.content,
      tool_calls: m.tool_calls,
      tool_call_id: m.tool_call_id,
      name: m.name,
    }));
    (async () => {
      try {
        const resp = await fetchResilient("/assistant/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, history: cleanHistory }),
          signal: ctrl.signal,
        });
        if (!resp.ok) {
          handlers.onError?.(`${resp.status} ${await resp.text()}`);
          return;
        }
        await consumeSSE(resp, (ev, data) => {
          try {
            const parsed = data ? JSON.parse(data) : {};
            if (ev === "token") handlers.onToken(parsed.text ?? "");
            else if (ev === "tool_start") handlers.onToolStart?.(parsed);
            else if (ev === "tool_end") handlers.onToolEnd?.(parsed);
            else if (ev === "artifact") handlers.onArtifact?.(parsed);
            else if (ev === "info") handlers.onInfo?.(parsed.message ?? "");
            else if (ev === "error") handlers.onError?.(parsed.error ?? "error");
            else if (ev === "done") handlers.onDone?.();
          } catch (err) {
            console.error("SSE parse", err, data);
          }
        }, ctrl.signal);
      } catch (e) {
        if ((e as { name?: string }).name !== "AbortError") {
          handlers.onError?.((e as Error).message);
        }
      }
    })();
    return ctrl;
  },

  /**
   * Run the AI draft pipeline (LangGraph: summarize -> draft) and stream tokens.
   * Returns an AbortController so the caller can cancel mid-stream.
   */
  draftFromChannel(channelPk: number, intent: string, handlers: DraftPipelineHandlers): AbortController {
    const ctrl = new AbortController();
    (async () => {
      try {
        const resp = await fetchResilient(`/drafts/from-channel/${channelPk}/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ intent, message_limit: 50 }),
          signal: ctrl.signal,
        });
        if (!resp.ok) {
          handlers.onError?.(`${resp.status} ${await resp.text()}`);
          return;
        }
        await consumeSSE(resp, (ev, data) => {
          try {
            const parsed = data ? JSON.parse(data) : {};
            if (ev === "phase") handlers.onPhase?.(parsed.phase);
            else if (ev === "summary_chunk") handlers.onSummaryChunk?.(parsed.text ?? "");
            else if (ev === "draft_chunk") handlers.onDraftChunk(parsed.text ?? "");
            else if (ev === "saved") handlers.onSaved?.(parsed.id, parsed.body);
            else if (ev === "error") handlers.onError?.(parsed.error ?? "error");
            else if (ev === "done") handlers.onDone?.();
          } catch (err) {
            console.error("SSE parse", err, data);
          }
        }, ctrl.signal);
      } catch (e) {
        if ((e as { name?: string }).name !== "AbortError") {
          handlers.onError?.((e as Error).message);
        }
      }
    })();
    return ctrl;
  },
};
