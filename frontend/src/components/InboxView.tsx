import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useWebSocket } from "../hooks/useWebSocket";
import type { Channel, Draft, Message, Summary, WsEvent } from "../types";
import { Composer } from "./Composer";

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

export function InboxView() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannelPk, setActiveChannelPk] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [summaryStreaming, setSummaryStreaming] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(true);
  const [unread, setUnread] = useState<Record<number, number>>({});
  const [syncing, setSyncing] = useState(false);
  const [channelFilter, setChannelFilter] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);

  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const summaryEsRef = useRef<EventSource | null>(null);

  const refreshChannels = useCallback(() => {
    api.channels().then(setChannels).catch(console.error);
  }, []);

  const refreshDrafts = useCallback(() => {
    if (activeChannelPk == null) { setDrafts([]); return; }
    api.drafts(activeChannelPk).then(setDrafts).catch(console.error);
  }, [activeChannelPk]);

  const reloadMessages = useCallback(() => {
    if (activeChannelPk == null) return;
    api.messages(activeChannelPk).then((m) => {
      setMessages([...m].reverse());
      stickToBottomRef.current = true;
    });
  }, [activeChannelPk]);

  useEffect(() => { refreshChannels(); }, [refreshChannels]);

  useEffect(() => {
    if (activeChannelPk == null) return;
    reloadMessages();
    refreshDrafts();
    setSummary(null);
    setUnread((u) => ({ ...u, [activeChannelPk]: 0 }));
  }, [activeChannelPk, reloadMessages, refreshDrafts]);

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

  const handleWs = useCallback((raw: unknown) => {
    const evt = raw as WsEvent;
    if (evt.type === "slack.message") {
      setChannels((prev) => {
        if (prev.some((c) => c.id === evt.channel_pk)) return prev;
        refreshChannels();
        return prev;
      });
      if (evt.channel_pk === activeChannelPk) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === evt.message.id)) return prev;
          return [...prev, {
            id: evt.message.id,
            ts: evt.message.ts,
            user_id: null,
            user_name: evt.message.user_name,
            text: evt.message.text,
            created_at: new Date().toISOString(),
          }];
        });
      } else {
        setUnread((u) => ({ ...u, [evt.channel_pk]: (u[evt.channel_pk] || 0) + 1 }));
      }
    } else if (evt.type === "draft.sent") {
      if (evt.channel_pk === activeChannelPk) {
        refreshDrafts();
        setTimeout(reloadMessages, 600);
      }
    } else if (evt.type === "draft.failed") {
      if (evt.channel_pk === activeChannelPk) refreshDrafts();
    }
  }, [activeChannelPk, refreshChannels, refreshDrafts, reloadMessages]);

  const connected = useWebSocket(wsUrl, handleWs);

  const activeChannel = channels.find((c) => c.id === activeChannelPk);
  const filteredChannels = useMemo(() => {
    const q = channelFilter.trim().toLowerCase();
    if (!q) return channels;
    return channels.filter((c) => c.name.toLowerCase().includes(q));
  }, [channels, channelFilter]);

  const channelDraftCount = useMemo(() => {
    const m: Record<number, number> = {};
    for (const d of drafts) {
      if (d.status === "scheduled" || d.status === "draft") {
        m[d.channel_pk] = (m[d.channel_pk] || 0) + 1;
      }
    }
    return m;
  }, [drafts]);

  const onSummarize = () => {
    if (activeChannelPk == null) return;
    summaryEsRef.current?.close();
    setSummaryOpen(true);
    setSummaryStreaming(true);
    setSummary({ channel_id: "", summary: "", message_count: 0 });

    summaryEsRef.current = api.summarizeStream(activeChannelPk, {
      onMeta: (m) => setSummary((prev) => ({
        channel_id: m.channel_id, summary: prev?.summary ?? "", message_count: m.message_count,
      })),
      onChunk: (text) => setSummary((prev) =>
        prev ? { ...prev, summary: prev.summary + text }
             : { channel_id: "", summary: text, message_count: 0 },
      ),
      onDone: () => setSummaryStreaming(false),
      onError: (err) => {
        setSummary({ channel_id: "", summary: `Failed to summarize: ${err}`, message_count: 0 });
        setSummaryStreaming(false);
      },
    });
  };

  useEffect(() => () => summaryEsRef.current?.close(), [activeChannelPk]);

  const onSyncNow = async () => {
    setSyncing(true);
    try {
      await api.syncNow();
      refreshChannels();
      reloadMessages();
    } catch (e) { console.error(e); }
    finally { setSyncing(false); }
  };

  return (
    <div className="inbox-shell">
      <section className="channel-list glass">
        <div className="panel-header">
          <h2>Channels</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className={`status-dot ${connected ? "connected" : ""}`} title={connected ? "Live" : "Reconnecting…"} />
            <span className="panel-count">{channels.length}</span>
          </div>
        </div>
        <div className="channel-filter">
          <input placeholder="Filter channels…" value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)} />
        </div>
        <div className="channel-scroll">
          {channels.length === 0 && (
            <div className="empty subtle">
              No channels yet. Set your Slack token, then wait for the first poll
              cycle (≈8s) or hit Sync now.
            </div>
          )}
          {filteredChannels.map((c) => {
            const av = avatarFor(c.name);
            const dCount = channelDraftCount[c.id] || 0;
            return (
              <button key={c.id} className={`channel-item ${activeChannelPk === c.id ? "active" : ""}`} onClick={() => setActiveChannelPk(c.id)}>
                <span className="channel-avatar" style={av.style}>{c.is_im ? "@" : "#"}</span>
                <span className="channel-name">{c.name}</span>
                {dCount > 0 && <span className="draft-pip" title={`${dCount} pending draft${dCount > 1 ? "s" : ""}`}>⏱</span>}
                {unread[c.id] ? <span className="badge">{unread[c.id]}</span> : null}
              </button>
            );
          })}
        </div>
        <button className="sync-btn" onClick={onSyncNow} disabled={syncing}>
          {syncing ? <><span className="spinner" /> Syncing…</> : <>↻ Sync now</>}
        </button>
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
                {summaryStreaming ? <><span className="spinner" /> Streaming…</> : <>✨ Brief</>}
              </button>
            </div>

            {summary && (
              <div className={`summary-box ${summaryOpen ? "" : "collapsed"}`}>
                <div className="label">
                  <span className={`label-dot ${summaryStreaming ? "live" : ""}`} />
                  Summary
                  {summary.message_count ? ` · ${summary.message_count} messages` : ""}
                  {summaryStreaming && <span className="live-tag">live</span>}
                  <button className="link-btn label-toggle" onClick={() => setSummaryOpen((s) => !s)}>
                    {summaryOpen ? "hide" : "show"}
                  </button>
                  <button className="link-btn" onClick={() => setSummary(null)}>×</button>
                </div>
                {summaryOpen && (
                  <div className={`summary-body ${summaryStreaming ? "streaming" : ""}`}>
                    {summary.summary}
                    {summaryStreaming && <span className="caret" />}
                  </div>
                )}
              </div>
            )}

            <div className="message-list" ref={listRef} onScroll={onListScroll}>
              {messages.length === 0 && <div className="empty">No messages loaded yet.</div>}
              {messages.map((m) => {
                const name = m.user_name || m.user_id || "unknown";
                const av = avatarFor(name);
                return (
                  <div key={m.id} className="message">
                    <div className="avatar" style={av.style}>{av.initials}</div>
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

            <Composer channel={activeChannel} onSent={reloadMessages} drafts={drafts} refreshDrafts={refreshDrafts} />
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
