import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { ActivitySnapshot, ChatArtifact, ChatMessage, ChatToolEvent } from "../types";
import { ActivityRail } from "./ActivityRail";
import { CommandPalette } from "./CommandPalette";
import { Markdown } from "./Markdown";
import { VoicePanel } from "./VoicePanel";

const TOOL_LABELS: Record<string, string> = {
  list_recent_activity: "checking activity",
  list_channels: "listing channels",
  ask_user_to_pick_channel: "asking which channel",
  ask_user_to_pick_draft: "asking which draft",
  summarize_channel: "summarizing",
  draft_reply: "drafting a reply",
  update_draft: "updating draft",
  send_message: "sending",
  schedule_message: "scheduling",
  schedule_message_at: "scheduling",
  list_drafts: "listing drafts",
  cancel_draft: "cancelling",
};

const STORAGE_KEY = "inbox:assistant:history:v1";

function loadHistory(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function saveHistory(h: ChatMessage[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(h.slice(-50))); } catch {}
}

export function AssistantView() {
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadHistory());
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [activity, setActivity] = useState<ActivitySnapshot | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  // Right rail can show either the live activity snapshot or the voice panel.
  // Voice keeps its own conversation history in localStorage, so switching
  // tabs doesn't pollute either thread.
  const [rightTab, setRightTab] = useState<"activity" | "voice">(() => {
    try {
      return (localStorage.getItem("inbox:rightTab") as "activity" | "voice") || "activity";
    } catch { return "activity"; }
  });
  useEffect(() => {
    try { localStorage.setItem("inbox:rightTab", rightTab); } catch {}
  }, [rightTab]);

  const ctrlRef = useRef<AbortController | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Persist history
  useEffect(() => { saveHistory(messages); }, [messages]);

  // Initial greeting
  useEffect(() => {
    if (messages.length === 0) {
      setMessages([{
        role: "assistant",
        content:
          "Hi — I'm your inbox assistant. Ask me what's new, draft a reply, schedule a send, " +
          "or just type / to see commands.",
      }]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshActivity = useCallback(() => {
    setActivityLoading(true);
    api.activity().then(setActivity).catch(console.error).finally(() => setActivityLoading(false));
  }, []);

  useEffect(() => { refreshActivity(); }, [refreshActivity]);

  // Auto-scroll on new tokens
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  // Auto-resize composer
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(Math.max(ta.scrollHeight, 44), 220) + "px";
  }, [input]);

  const send = useCallback((messageOverride?: string) => {
    const msg = (messageOverride ?? input).trim();
    if (!msg || streaming) return;
    ctrlRef.current?.abort();

    const historyForSend = [...messages];
    const userMsg: ChatMessage = { role: "user", content: msg };
    // Placeholder assistant message we'll mutate as tokens arrive
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: "",
      tool_events: [],
      artifacts: [],
    };
    setMessages([...messages, userMsg, assistantMsg]);
    setInput("");
    setStreaming(true);

    const patchLast = (mutator: (m: ChatMessage) => ChatMessage) =>
      setMessages((prev) => {
        const next = prev.slice();
        const last = next[next.length - 1];
        if (last && last.role === "assistant") next[next.length - 1] = mutator(last);
        return next;
      });

    ctrlRef.current = api.assistantChat(msg, historyForSend, {
      onToken: (t) => patchLast((m) => ({ ...m, content: (m.content || "") + t })),
      onToolStart: (ev) => patchLast((m) => {
        const tools: ChatToolEvent[] = m.tool_events ? [...m.tool_events] : [];
        tools.push({ id: ev.id, name: ev.name, status: "running", input: ev.input });
        // Pre-tool tokens are the model's "thinking out loud" — discard them
        // once we actually call a tool. The post-tool text is the real reply.
        return { ...m, tool_events: tools, content: "" };
      }),
      onToolEnd: (ev) => patchLast((m) => {
        const tools: ChatToolEvent[] = (m.tool_events || []).map((t) =>
          t.id === ev.id ? { ...t, status: "done", output: ev.output } : t,
        );
        return { ...m, tool_events: tools };
      }),
      onArtifact: (a) => patchLast((m) => ({ ...m, artifacts: [...(m.artifacts || []), a] })),
      onInfo: (msg) => patchLast((m) => ({
        ...m,
        content: (m.content || "") + (m.content && !m.content.endsWith("\n") ? "\n" : "") + `_${msg}_\n`,
      })),
      onDone: () => {
        setStreaming(false);
        // Tool-driven actions may have changed activity (drafts, scheduled). Refresh.
        refreshActivity();
      },
      onError: (err) => {
        patchLast((m) => ({ ...m, content: (m.content || "") + `\n\n[error: ${err}]` }));
        setStreaming(false);
      },
    });
  }, [input, messages, streaming, refreshActivity]);

  const stop = () => {
    ctrlRef.current?.abort();
    setStreaming(false);
  };

  const clearChat = () => {
    // Skip confirm when there's nothing meaningful to lose (just the greeting).
    const meaningful = messages.filter((m) => m.role === "user").length;
    if (meaningful > 0 && !window.confirm("Clear this conversation? This can't be undone.")) {
      return;
    }
    ctrlRef.current?.abort();
    setMessages([]);
    setStreaming(false);
    setInput("");
    localStorage.removeItem(STORAGE_KEY);
  };

  const turnCount = messages.filter((m) => m.role === "user").length;

  // Command palette state
  const paletteOpen = input.startsWith("/") && !streaming;
  const paletteQuery = paletteOpen ? input : "";

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !paletteOpen) {
      e.preventDefault();
      send();
    }
  };

  // Replace the artifact on whatever assistant message contains the given draft id.
  const updateDraftArtifact = useCallback((draftId: number, replacement: ChatArtifact) => {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.role !== "assistant" || !m.artifacts?.some((a) => a.draft_id === draftId)) {
          return m;
        }
        return {
          ...m,
          artifacts: m.artifacts.map((a) =>
            a.draft_id === draftId ? { ...a, ...replacement } : a,
          ),
        };
      }),
    );
  }, []);

  // --- artifact action handlers ---
  const sendDraft = async (draftId: number) => {
    try {
      const sent = await api.sendDraft(draftId);
      updateDraftArtifact(draftId, {
        type: "sent",
        draft_id: draftId,
        channel: sent.body ? undefined : undefined,
        ts: sent.sent_ts ?? undefined,
      });
      refreshActivity();
    } catch (e) {
      alert(`Send failed: ${(e as Error).message}`);
    }
  };
  // Mark a picker artifact as resolved and send the chosen channel as the next message.
  const pickChannelFromArtifact = (channelName: string, intent: string, atIndex: number) => {
    setMessages((prev) =>
      prev.map((m, i) => {
        if (i !== atIndex || m.role !== "assistant") return m;
        return {
          ...m,
          artifacts: (m.artifacts || []).map((a) =>
            a.type === "channel_picker" ? { ...a, picked: channelName } : a,
          ),
        };
      }),
    );
    const verb = (intent || "").trim() || "use";
    const followup = /#|@/.test(verb) ? verb : `${verb} #${channelName}`;
    send(followup);
  };

  const pickDraftFromArtifact = (draftId: number, verb: string, atIndex: number) => {
    setMessages((prev) =>
      prev.map((m, i) => {
        if (i !== atIndex || m.role !== "assistant") return m;
        return {
          ...m,
          artifacts: (m.artifacts || []).map((a) =>
            a.type === "draft_picker" ? { ...a, picked: String(draftId) } : a,
          ),
        };
      }),
    );
    const v = (verb || "send").trim().toLowerCase();
    const followup =
      v === "cancel" ? `Cancel draft ${draftId}` :
      v === "send"   ? `Send draft ${draftId}` :
      v === "edit"   ? `Edit draft ${draftId}` :
      v === "refine" ? `Refine draft ${draftId}` :
      v === "schedule" ? `Schedule draft ${draftId}` :
      `${v} draft ${draftId}`;
    send(followup);
  };

  const cancelScheduled = async (draftId: number) => {
    try {
      await api.deleteDraft(draftId);
      updateDraftArtifact(draftId, { type: "sent", draft_id: draftId });
      // Actually it was discarded — strip the artifact entirely instead.
      setMessages((prev) =>
        prev.map((m) =>
          m.role === "assistant"
            ? { ...m, artifacts: (m.artifacts || []).filter((a) => a.draft_id !== draftId) }
            : m,
        ),
      );
      refreshActivity();
    } catch (e) {
      alert(`Cancel failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className="assistant-shell">
      <main className="assistant-center glass">
        <header className="assistant-header">
          <div className="assistant-title">
            <span className="assistant-orb" />
            <div>
              <h1>Assistant</h1>
              <p className="assistant-sub">Your communication helper · ask anything · type / for commands</p>
            </div>
          </div>
          <div className="assistant-tools">
            {turnCount > 0 && (
              <span className="turn-count" title={`${turnCount} message${turnCount === 1 ? "" : "s"} this conversation`}>
                {turnCount} turn{turnCount === 1 ? "" : "s"}
              </span>
            )}
            <button
              className="clear-btn"
              onClick={clearChat}
              disabled={streaming}
              title="Clear conversation and start fresh"
            >
              <span className="clear-icon">🗑</span>
              Clear chat
            </button>
          </div>
        </header>

        <div className="chat-scroll" ref={scrollRef}>
          {messages.map((m, i) => (
            <ChatBubble
              key={i}
              message={m}
              messageIndex={i}
              streaming={streaming && i === messages.length - 1}
              onSendDraft={sendDraft}
              onCancelScheduled={cancelScheduled}
              onPickChannel={pickChannelFromArtifact}
              onPickDraft={pickDraftFromArtifact}
              onAsk={(q) => send(q)}
            />
          ))}
        </div>

        <div className="chat-composer">
          {paletteOpen && (
            <CommandPalette
              query={paletteQuery}
              onPick={(cmd) => {
                setInput(cmd.template);
                requestAnimationFrame(() => taRef.current?.focus());
              }}
              onDismiss={() => setInput("")}
            />
          )}
          <textarea
            ref={taRef}
            className="composer-input chat-input"
            placeholder="Message your assistant — type / for commands · ↵ to send · ⇧↵ for newline"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            rows={1}
            disabled={streaming}
          />
          <div className="chat-send">
            {streaming ? (
              <button className="btn-ghost-pill" onClick={stop}>Stop</button>
            ) : (
              <button className="btn-glow" disabled={!input.trim()} onClick={() => send()}>
                Send
              </button>
            )}
          </div>
        </div>
      </main>

      <aside className="rail-shell glass">
        <div className="rail-tabs">
          <button
            className={`rail-tab ${rightTab === "activity" ? "active" : ""}`}
            onClick={() => setRightTab("activity")}
          >
            <span>📊</span> Activity
          </button>
          <button
            className={`rail-tab ${rightTab === "voice" ? "active" : ""}`}
            onClick={() => setRightTab("voice")}
            title="Voice mode — separate conversation thread"
          >
            <span>🎙</span> Voice
          </button>
        </div>
        <div className="rail-body">
          {rightTab === "activity" ? (
            <ActivityRail
              snapshot={activity}
              loading={activityLoading}
              onRefresh={refreshActivity}
              onAsk={(q) => send(q)}
            />
          ) : (
            <VoicePanel />
          )}
        </div>
      </aside>
    </div>
  );
}


interface BubbleProps {
  message: ChatMessage;
  messageIndex: number;
  streaming: boolean;
  onSendDraft: (draftId: number) => void;
  onCancelScheduled: (draftId: number) => void;
  onPickChannel: (channelName: string, intent: string, atIndex: number) => void;
  onPickDraft: (draftId: number, verb: string, atIndex: number) => void;
  onAsk: (q: string) => void;
}

function ChatBubble({
  message,
  messageIndex,
  streaming,
  onSendDraft,
  onCancelScheduled,
  onPickChannel,
  onPickDraft,
  onAsk,
}: BubbleProps) {
  if (message.role === "system" || message.role === "tool") return null;

  const isUser = message.role === "user";
  const cls = isUser ? "chat-msg user" : "chat-msg assistant";
  const activeTools = (message.tool_events || []).filter((t) => t.status === "running");
  const finishedTools = (message.tool_events || []).filter((t) => t.status === "done");

  return (
    <div className={cls}>
      {!isUser && <div className="chat-avatar assistant-avatar">A</div>}
      <div className="chat-body">
        {finishedTools.length > 0 && (
          <div className="tool-strip">
            {finishedTools.map((t) => (
              <span key={t.id} className="tool-tag done">
                {TOOL_LABELS[t.name] || t.name}
              </span>
            ))}
          </div>
        )}
        {message.content && (
          <div className="chat-text">
            {isUser ? message.content : <Markdown text={message.content} />}
            {streaming && <span className="caret" />}
          </div>
        )}
        {activeTools.length > 0 && (
          <div className="tool-strip">
            {activeTools.map((t) => (
              <span key={t.id} className="tool-tag running">
                <span className="spinner" /> {TOOL_LABELS[t.name] || t.name}…
              </span>
            ))}
          </div>
        )}
        {message.artifacts && message.artifacts.length > 0 && (
          <ArtifactStrip
            artifacts={message.artifacts}
            messageIndex={messageIndex}
            onSendDraft={onSendDraft}
            onCancelScheduled={onCancelScheduled}
            onPickChannel={onPickChannel}
            onPickDraft={onPickDraft}
            onAsk={onAsk}
          />
        )}
      </div>
      {isUser && <div className="chat-avatar user-avatar">You</div>}
    </div>
  );
}


function ArtifactStrip({
  artifacts,
  messageIndex,
  onSendDraft,
  onCancelScheduled,
  onPickChannel,
  onPickDraft,
  onAsk,
}: {
  artifacts: ChatArtifact[];
  messageIndex: number;
  onSendDraft: (id: number) => void;
  onCancelScheduled: (id: number) => void;
  onPickChannel: (channelName: string, intent: string, atIndex: number) => void;
  onPickDraft: (draftId: number, verb: string, atIndex: number) => void;
  onAsk: (q: string) => void;
}) {
  return (
    <div className="artifacts">
      {artifacts.map((a, i) => {
        if (a.type === "channel_picker" && a.channels) {
          if (a.picked) {
            return (
              <div key={i} className="artifact picker resolved">
                <span className="artifact-label">
                  ✓ {a.intent} <strong>#{a.picked}</strong>
                </span>
              </div>
            );
          }
          return (
            <div key={i} className="artifact picker">
              <div className="artifact-head">
                <span className="artifact-label">Pick a channel to {a.intent}</span>
              </div>
              <div className="picker-grid">
                {a.channels.map((c) => (
                  <button
                    key={c.channel_pk}
                    className="picker-chip"
                    onClick={() => onPickChannel(c.name, a.intent || "use", messageIndex)}
                  >
                    <span className="picker-glyph">{c.is_dm ? "@" : "#"}</span>
                    {c.name}
                  </button>
                ))}
              </div>
            </div>
          );
        }
        if (a.type === "draft_picker" && a.drafts) {
          const verb = a.verb || "send";
          if (a.picked) {
            return (
              <div key={i} className="artifact picker resolved">
                <span className="artifact-label">
                  ✓ {verb} draft <strong>#{a.picked}</strong>
                </span>
              </div>
            );
          }
          if (a.drafts.length === 0) {
            return (
              <div key={i} className="artifact picker empty">
                <span className="artifact-label">No drafts to {verb}.</span>
              </div>
            );
          }
          return (
            <div key={i} className="artifact picker draft-picker">
              <div className="artifact-head">
                <span className="artifact-label">Pick a draft to {verb}</span>
              </div>
              <div className="draft-picker-list">
                {a.drafts.map((d) => (
                  <button
                    key={d.draft_id}
                    className="draft-picker-row"
                    onClick={() => onPickDraft(d.draft_id, verb, messageIndex)}
                  >
                    <div className="draft-picker-head">
                      <span className="picker-glyph">{d.is_dm ? "@" : "#"}{d.channel}</span>
                      <span className={`rail-status status-${d.status}`}>
                        {d.status === "scheduled" && d.scheduled_for
                          ? `⏱ ${new Date(d.scheduled_for).toLocaleString()}`
                          : d.status}
                      </span>
                      <span className="artifact-id">#{d.draft_id}</span>
                    </div>
                    <div className="draft-picker-preview">{d.body_preview}</div>
                  </button>
                ))}
              </div>
            </div>
          );
        }
        if (a.type === "draft" && a.draft_id && a.body) {
          return (
            <div key={i} className="artifact draft">
              <div className="artifact-head">
                <span className="artifact-label">Draft for #{a.channel}</span>
                <span className="artifact-id">#{a.draft_id}</span>
              </div>
              <pre className="artifact-body">{a.body}</pre>
              <div className="artifact-actions">
                <button className="btn-glow small" onClick={() => onSendDraft(a.draft_id!)}>
                  Send
                </button>
                <button className="chip-action" onClick={() => onAsk(`Schedule draft ${a.draft_id} for `)}>
                  ⏱ Schedule
                </button>
                <button className="chip-action" onClick={() => onAsk(`Refine draft ${a.draft_id}: `)}>
                  ↻ Refine
                </button>
                <button className="chip-action danger" onClick={() => onCancelScheduled(a.draft_id!)}>
                  Discard
                </button>
              </div>
            </div>
          );
        }
        if (a.type === "scheduled" && a.draft_id) {
          return (
            <div key={i} className="artifact scheduled">
              <span className="artifact-label">⏱ Scheduled draft #{a.draft_id}</span>
              {a.scheduled_for && (
                <span className="artifact-when">
                  for {new Date(a.scheduled_for).toLocaleString()}
                </span>
              )}
              <button className="chip-action danger" onClick={() => onCancelScheduled(a.draft_id!)}>
                Cancel
              </button>
            </div>
          );
        }
        if (a.type === "sent" && a.draft_id) {
          return (
            <div key={i} className="artifact sent">
              <span className="artifact-label">✓ Sent to #{a.channel}</span>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}
