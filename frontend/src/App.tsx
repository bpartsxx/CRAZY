import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { useWebSocket } from "./hooks/useWebSocket";
import type { Channel, Message, SlackMessageEvent, Summary } from "./types";

export default function App() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannelPk, setActiveChannelPk] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [unread, setUnread] = useState<Record<number, number>>({});

  useEffect(() => {
    api.channels().then(setChannels).catch(console.error);
  }, []);

  useEffect(() => {
    if (activeChannelPk == null) return;
    api.messages(activeChannelPk).then((m) => {
      // backend returns newest-first; flip for chronological display
      setMessages([...m].reverse());
    });
    setSummary(null);
    setUnread((u) => ({ ...u, [activeChannelPk]: 0 }));
  }, [activeChannelPk]);

  const wsUrl = useMemo(() => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${window.location.host}/ws`;
  }, []);

  const handleWs = useCallback(
    (raw: unknown) => {
      const evt = raw as SlackMessageEvent;
      if (evt.type !== "slack.message") return;
      if (evt.channel_pk === activeChannelPk) {
        setMessages((prev) => [
          ...prev,
          {
            id: evt.message.id,
            ts: evt.message.ts,
            user_id: null,
            user_name: evt.message.user_name,
            text: evt.message.text,
            created_at: new Date().toISOString(),
          },
        ]);
      } else {
        setUnread((u) => ({ ...u, [evt.channel_pk]: (u[evt.channel_pk] || 0) + 1 }));
      }
    },
    [activeChannelPk],
  );

  const connected = useWebSocket(wsUrl, handleWs);

  const activeChannel = channels.find((c) => c.id === activeChannelPk);

  const onSummarize = async () => {
    if (activeChannelPk == null) return;
    setSummaryLoading(true);
    try {
      const s = await api.summarize(activeChannelPk);
      setSummary(s);
    } catch (e) {
      setSummary({
        channel_id: "",
        summary: `Failed to summarize: ${e instanceof Error ? e.message : "unknown error"}`,
        message_count: 0,
      });
    } finally {
      setSummaryLoading(false);
    }
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>Inbox</h1>
        <div className="nav-item active">Slack</div>
        <div className="nav-item disabled">Gmail (soon)</div>
        <div className="nav-item disabled">WhatsApp (soon)</div>
        <div style={{ marginTop: 24, fontSize: 12, color: "#888" }}>
          <span className={`status-dot ${connected ? "connected" : ""}`} />
          {connected ? "Live" : "Reconnecting…"}
        </div>
      </aside>

      <section className="channel-list">
        <h2>Channels</h2>
        {channels.length === 0 && (
          <div className="empty" style={{ padding: 16, fontSize: 13 }}>
            No channels yet. Make sure your Slack token is set, then wait for the
            first poll cycle (≈30s) or hit POST /slack/sync.
          </div>
        )}
        {channels.map((c) => (
          <div
            key={c.id}
            className={`channel-item ${activeChannelPk === c.id ? "active" : ""}`}
            onClick={() => setActiveChannelPk(c.id)}
          >
            <span>{c.is_im ? "@" : "#"}{c.name}</span>
            {unread[c.id] ? <span className="badge">{unread[c.id]}</span> : null}
          </div>
        ))}
      </section>

      <main className="main">
        {activeChannel ? (
          <>
            <div className="main-header">
              <h2>{activeChannel.is_im ? "@" : "#"}{activeChannel.name}</h2>
              <button onClick={onSummarize} disabled={summaryLoading}>
                {summaryLoading ? "Summarizing…" : "Summarize recent"}
              </button>
            </div>
            {summary && (
              <div className="summary-box">
                <div className="label">Summary · {summary.message_count} messages</div>
                {summary.summary}
              </div>
            )}
            <div className="message-list">
              {messages.length === 0 && <div className="empty">No messages loaded yet.</div>}
              {messages.map((m) => (
                <div key={m.id} className="message">
                  <div className="meta">
                    <span className="author">{m.user_name || m.user_id || "unknown"}</span>
                    <span>{new Date(parseFloat(m.ts) * 1000).toLocaleString()}</span>
                  </div>
                  <div className="text">{m.text}</div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="empty">Pick a channel on the left.</div>
        )}
      </main>
    </div>
  );
}
