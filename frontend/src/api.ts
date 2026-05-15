import type { Channel, Message, Summary } from "./types";

async function jsonOrThrow<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

export interface SummaryStreamHandlers {
  onMeta?: (m: { channel_id: string; message_count: number }) => void;
  onChunk: (text: string) => void;
  onDone?: () => void;
  onError?: (err: string) => void;
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

  /**
   * Open an SSE connection to stream a summary token-by-token.
   * Returns the EventSource so the caller can close() it on unmount/cancel.
   */
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
};
