import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { useWebSocket } from "./hooks/useWebSocket";
import type { Channel, Message, SlackMessageEvent, Summary } from "./types";

function avatarFor(name: string | null | undefined) {
  const safe = (name || "?").trim() || "?";
  const initials = safe
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("") || "?";
  let hash = 0;
  for (let i = 0; i < safe.length; i++) hash = (hash * 31 + safe.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  const hue2 = (hue + 48) % 360;
  return {
    initials,
    style: {
      background: `linear-gradient(135deg, hsl(${hue} 80% 62%), hsl(${hue2} 75% 48%))`,
    } as React.CSSProperties,
  };
}

function formatTime(ts: string) {
  const d = new Date(parseFloat(ts) * 1000);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function App() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannelPk, setActiveChannelPk] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [summaryStreaming, setSummaryStreaming] = useState(false);
  const [unread, setUnread] = useState<Record<number, number>>({});
  const [syncing, setSyncing] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const summaryEsRef = useRef<EventSource | null>(null);

  const refreshChannels = useCallback(() => {
    api.channels().then(setChannels).catch(console.error);
  }, []);

  useEffect(() => {
    refreshChannels();
  }, [refreshChannels]);

  useEffect(() => {
    if (activeChannelPk == null) return;
    api.messages(activeChannelPk).then((m) => {
      setMessages([...m].reverse());
      stickToBottomRef.current = true;
    });
    setSummary(null);
    setUnread((u) => ({ ...u, [activeChannelPk]: 0 }));
  }, [activeChannelPk]);

  // Auto-scroll to bottom on new messages — but only if user is already near it.
  useEffect(() => {
    const el = listRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const wsUrl = useMemo(() => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${window.location.host}/ws`;
  }, []);

  const handleWs = useCallback(
    (raw: unknown) => {
      const evt = raw as SlackMessageEvent;
      if (evt.type !== "slack.message") return;

      // Refresh sidebar if this message references a channel we don't know yet
      // (e.g. a brand-new DM or a freshly-joined channel).
      setChannels((prev) => {
        if (prev.some((c) => c.id === evt.channel_pk)) return prev;
        refreshChannels();
        return prev;
      });

      if (evt.channel_pk === activeChannelPk) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === evt.message.id)) return prev;
          return [
            ...prev,
            {
              id: evt.message.id,
              ts: evt.message.ts,
              user_id: null,
              user_name: evt.message.user_name,
              text: evt.message.text,
              created_at: new Date().toISOString(),
            },
          ];
        });
      } else {
        setUnread((u) => ({ ...u, [evt.channel_pk]: (u[evt.channel_pk] || 0) + 1 }));
      }
    },
    [activeChannelPk, refreshChannels],
  );

  const connected = useWebSocket(wsUrl, handleWs);

  const activeChannel = channels.find((c) => c.id === activeChannelPk);

  const onSummarize = () => {
    if (activeChannelPk == null) return;
    summaryEsRef.current?.close();
    setSummaryStreaming(true);
    setSummary({ channel_id: "", summary: "", message_count: 0 });

    summaryEsRef.current = api.summarizeStream(activeChannelPk, {
      onMeta: (m) =>
        setSummary((prev) => ({
          channel_id: m.channel_id,
          summary: prev?.summary ?? "",
          message_count: m.message_count,
        })),
      onChunk: (text) =>
        setSummary((prev) =>
          prev
            ? { ...prev, summary: prev.summary + text }
            : { channel_id: "", summary: text, message_count: 0 },
        ),
      onDone: () => setSummaryStreaming(false),
      onError: (err) => {
        setSummary({
          channel_id: "",
          summary: `Failed to summarize: ${err}`,
          message_count: 0,
        });
        setSummaryStreaming(false);
      },
    });
  };

  // Cleanup any open SSE on unmount or channel change
  useEffect(() => {
    return () => summaryEsRef.current?.close();
  }, [activeChannelPk]);

  const onSyncNow = async () => {
    setSyncing(true);
    try {
      await api.syncNow();
      refreshChannels();
      if (activeChannelPk != null) {
        const m = await api.messages(activeChannelPk);
        setMessages([...m].reverse());
      }
    } catch (e) {
      console.error(e);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="app">
      <aside className="sidebar glass">
        <div className="brand">
          <span className="brand-mark" />
          <span className="brand-name">Inbox</span>
        </div>
        <nav className="nav">
          <div className="nav-item active">
            <span className="nav-dot" /> Slack
          </div>
          <div className="nav-item disabled">
            <span className="nav-dot" /> Gmail<span className="nav-tag">soon</span>
          </div>
          <div className="nav-item disabled">
            <span className="nav-dot" /> WhatsApp<span className="nav-tag">soon</span>
          </div>
        </nav>
        <button
          className="sync-btn"
          onClick={onSyncNow}
          disabled={syncing}
          title="Force a Slack poll right now"
        >
          {syncing ? <><span className="spinner" /> Syncing…</> : <>↻ Sync now</>}
        </button>
        <div className="status">
          <span className={`status-dot ${connected ? "connected" : ""}`} />
          <span>{connected ? "Live" : "Reconnecting…"}</span>
        </div>
      </aside>

      <section className="channel-list glass">
        <div className="panel-header">
          <h2>Channels</h2>
          <span className="panel-count">{channels.length}</span>
        </div>
        <div className="channel-scroll">
          {channels.length === 0 && (
            <div className="empty subtle">
              No channels yet. Set your Slack token, then wait for the first poll
              cycle (≈8s) or hit Sync now.
            </div>
          )}
          {channels.map((c) => {
            const av = avatarFor(c.name);
            return (
              <button
                key={c.id}
                className={`channel-item ${activeChannelPk === c.id ? "active" : ""}`}
                onClick={() => setActiveChannelPk(c.id)}
              >
                <span className="channel-avatar" style={av.style}>
                  {c.is_im ? "@" : "#"}
                </span>
                <span className="channel-name">{c.name}</span>
                {unread[c.id] ? <span className="badge">{unread[c.id]}</span> : null}
              </button>
            );
          })}
        </div>
      </section>

      <main className="main glass">
        {activeChannel ? (
          <>
            <div className="main-header">
              <div className="main-title">
                <span className="title-glyph">{activeChannel.is_im ? "@" : "#"}</span>
                <h2>{activeChannel.name}</h2>
              </div>
              <button className="btn-glow" onClick={onSummarize} disabled={summaryStreaming}>
                {summaryStreaming ? (
                  <>
                    <span className="spinner" /> Streaming…
                  </>
                ) : (
                  <>✨ Summarize recent</>
                )}
              </button>
            </div>

            {summary && (
              <div className="summary-box">
                <div className="label">
                  <span className={`label-dot ${summaryStreaming ? "live" : ""}`} />
                  Summary
                  {summary.message_count ? ` · ${summary.message_count} messages` : ""}
                  {summaryStreaming && <span className="live-tag">live</span>}
                </div>
                <div className={`summary-body ${summaryStreaming ? "streaming" : ""}`}>
                  {summary.summary}
                  {summaryStreaming && <span className="caret" />}
                </div>
              </div>
            )}

            <div className="message-list" ref={listRef} onScroll={onListScroll}>
              {messages.length === 0 && (
                <div className="empty">No messages loaded yet.</div>
              )}
              {messages.map((m) => {
                const name = m.user_name || m.user_id || "unknown";
                const av = avatarFor(name);
                return (
                  <div key={m.id} className="message">
                    <div className="avatar" style={av.style}>
                      {av.initials}
                    </div>
                    <div className="bubble">
                      <div className="meta">
                        <span className="author">{name}</span>
                        <span className="time">{formatTime(m.ts)}</span>
                      </div>
                      <div className="text">{m.text}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="empty hero">
            <div className="hero-glow" />
            <div className="hero-text">
              <h3>Select a channel</h3>
              <p>Pick a conversation on the left to start reading.</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
