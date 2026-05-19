import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useSpeechRecognition, useSpeechSynthesis } from "../hooks/useSpeech";
import type { ChatArtifact, ChatMessage } from "../types";

// Shared with the text Assistant view so the conversation carries across modes.
const STORAGE_KEY = "inbox:assistant:history:v1";

/**
 * Strip Markdown / emoji / weird whitespace so TTS sounds natural instead of
 * reading "asterisk asterisk send asterisk asterisk". Also used for the
 * live subtitle so the on-screen text matches what's spoken.
 */
function stripForSpeech(s: string): string {
  return s
    // Code blocks — skip entirely (TTS shouldn't read code)
    .replace(/```[\s\S]*?```/g, "")
    // Inline code → keep contents, drop backticks
    .replace(/`([^`]+)`/g, "$1")
    // Bold / italic / strike — strip markers, keep text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/~~([^~]+)~~/g, "$1")
    // Markdown links [text](url) → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Headings, blockquotes, horizontal rules
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^[-*_]{3,}\s*$/gm, "")
    // Bullet markers at line start
    .replace(/^\s*[-*+•]\s+/gm, "")
    // Em / en dashes → comma for a natural spoken pause
    .replace(/\s*[—–]\s*/g, ", ")
    // Narrow / non-breaking spaces → normal space
    .replace(/[   ]/g, " ")
    // Pictographic emoji that TTS reads literally ("stopwatch", "trash can"…)
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}]/gu, "")
    // Collapse whitespace
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function loadHistory(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function saveHistory(h: ChatMessage[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(h.slice(-50))); } catch {}
}

type Phase = "idle" | "listening" | "thinking" | "speaking";

// Match Llama tool names to human-readable status phrases for subtitles.
const TOOL_PHRASES: Record<string, string> = {
  list_recent_activity: "Checking what's new…",
  list_channels: "Looking at your channels…",
  ask_user_to_pick_channel: "Which channel?",
  ask_user_to_pick_draft: "Which draft?",
  summarize_channel: "Reading the channel…",
  draft_reply: "Drafting a reply…",
  update_draft: "Updating the draft…",
  send_message: "Sending…",
  schedule_message: "Scheduling…",
  schedule_message_at: "Scheduling…",
  list_drafts: "Looking at your drafts…",
  cancel_draft: "Cancelling…",
};

export function VoiceView() {
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadHistory());
  const [subtitleAssistant, setSubtitleAssistant] = useState("");
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);

  const stt = useSpeechRecognition();
  const tts = useSpeechSynthesis();
  const ctrlRef = useRef<AbortController | null>(null);
  const sentenceBufRef = useRef("");

  useEffect(() => { saveHistory(messages); }, [messages]);
  useEffect(() => () => {
    ctrlRef.current?.abort();
    tts.cancel();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Flush the sentence buffer through TTS at every full sentence boundary. */
  const drainBuffer = useCallback((flushAll: boolean) => {
    let buf = sentenceBufRef.current;
    const speakClean = (raw: string) => {
      const cleaned = stripForSpeech(raw);
      if (cleaned) tts.speak(cleaned);
    };
    while (true) {
      // Match up to the first sentence-ending punctuation (or newline)
      const m = buf.match(/[\s\S]*?[.!?]["'\)\]]?(\s|$)|[\s\S]*?\n/);
      if (!m) break;
      speakClean(m[0]);
      buf = buf.slice(m[0].length);
    }
    if (flushAll && buf.trim()) {
      speakClean(buf);
      buf = "";
    }
    sentenceBufRef.current = buf;
  }, [tts]);

  const sendToAssistant = useCallback((text: string) => {
    if (!text.trim() || streaming) return;
    ctrlRef.current?.abort();
    tts.cancel();

    const historyForSend = [...messages];
    const userMsg: ChatMessage = { role: "user", content: text };
    const assistantMsg: ChatMessage = { role: "assistant", content: "", tool_events: [], artifacts: [] };
    setMessages([...messages, userMsg, assistantMsg]);
    setSubtitleAssistant("");
    setToolStatus(null);
    setStreaming(true);
    sentenceBufRef.current = "";

    const patchLast = (mut: (m: ChatMessage) => ChatMessage) =>
      setMessages((prev) => {
        const next = prev.slice();
        const last = next[next.length - 1];
        if (last && last.role === "assistant") next[next.length - 1] = mut(last);
        return next;
      });

    ctrlRef.current = api.assistantChat(text, historyForSend, {
      onToken: (t) => {
        patchLast((m) => ({ ...m, content: (m.content || "") + t }));
        setSubtitleAssistant((s) => s + t);
        sentenceBufRef.current += t;
        drainBuffer(false);
      },
      onToolStart: (ev) => {
        setToolStatus(TOOL_PHRASES[ev.name] || "Working…");
        patchLast((m) => ({
          ...m,
          tool_events: [...(m.tool_events || []), { id: ev.id, name: ev.name, status: "running", input: ev.input }],
        }));
      },
      onToolEnd: (ev) => {
        setToolStatus(null);
        patchLast((m) => ({
          ...m,
          tool_events: (m.tool_events || []).map((te) =>
            te.id === ev.id ? { ...te, status: "done", output: ev.output } : te,
          ),
        }));
      },
      onArtifact: (a) => {
        patchLast((m) => ({ ...m, artifacts: [...(m.artifacts || []), a] }));
        // Announce key artifacts out loud so voice-only users know what happened.
        if (a.type === "channel_picker") tts.speak("Which channel?");
        else if (a.type === "draft_picker") tts.speak("Which draft?");
        else if (a.type === "sent") tts.speak("Sent.");
        else if (a.type === "scheduled") tts.speak("Scheduled.");
      },
      onDone: () => {
        drainBuffer(true);
        setStreaming(false);
        setToolStatus(null);
      },
      onError: (err) => {
        setSubtitleAssistant((s) => s + `\n[error: ${err}]`);
        setStreaming(false);
        setToolStatus(null);
      },
    });
  }, [messages, streaming, tts, drainBuffer]);

  // When the user stops talking, fire the final transcript.
  const lastSubmittedRef = useRef("");
  useEffect(() => {
    if (!stt.listening && stt.finalTranscript && stt.finalTranscript !== lastSubmittedRef.current) {
      lastSubmittedRef.current = stt.finalTranscript;
      sendToAssistant(stt.finalTranscript);
    }
  }, [stt.listening, stt.finalTranscript, sendToAssistant]);

  const handleMicClick = () => {
    if (stt.listening) {
      stt.stop();
      return;
    }
    if (streaming || tts.speaking) {
      // Interrupting — cancel ongoing speech and start fresh listening.
      ctrlRef.current?.abort();
      tts.cancel();
      setStreaming(false);
    }
    stt.start();
  };

  const handleStopSpeaking = () => {
    tts.cancel();
    ctrlRef.current?.abort();
    setStreaming(false);
  };

  const handleClear = () => {
    if (messages.filter((m) => m.role === "user").length > 0 &&
        !window.confirm("Clear this conversation?")) return;
    ctrlRef.current?.abort();
    tts.cancel();
    setMessages([]);
    setSubtitleAssistant("");
    sentenceBufRef.current = "";
    localStorage.removeItem(STORAGE_KEY);
  };

  // ---------- interactive artifacts ----------

  /** Find the latest assistant message that has unresolved artifacts. */
  const currentInteraction = useMemo<{ messageIndex: number; artifacts: ChatArtifact[] } | null>(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant" || !m.artifacts?.length) continue;
      // Resolved artifacts are those that were "picked" or are status=sent/cancelled.
      const unresolved = m.artifacts.filter(
        (a) => !a.picked && a.type !== "sent" && a.status !== "cancelled",
      );
      if (unresolved.length > 0) return { messageIndex: i, artifacts: m.artifacts };
      // If there ARE artifacts but all resolved, still show as confirmations on the latest turn.
      return { messageIndex: i, artifacts: m.artifacts };
    }
    return null;
  }, [messages]);

  const mutateArtifact = (msgIdx: number, predicate: (a: ChatArtifact) => boolean, patch: Partial<ChatArtifact>) =>
    setMessages((prev) => prev.map((m, i) => {
      if (i !== msgIdx || m.role !== "assistant" || !m.artifacts) return m;
      return { ...m, artifacts: m.artifacts.map((a) => (predicate(a) ? { ...a, ...patch } : a)) };
    }));

  const pickChannel = (channelName: string, intent: string, msgIdx: number) => {
    mutateArtifact(msgIdx, (a) => a.type === "channel_picker" && !a.picked, { picked: channelName });
    const verb = (intent || "use").trim();
    const followup = /#|@/.test(verb) ? verb : `${verb} #${channelName}`;
    sendToAssistant(followup);
  };

  const pickDraft = (draftId: number, verb: string, msgIdx: number) => {
    mutateArtifact(msgIdx, (a) => a.type === "draft_picker" && !a.picked, { picked: String(draftId) });
    const v = (verb || "send").trim().toLowerCase();
    const followup =
      v === "cancel" ? `Cancel draft ${draftId}` :
      v === "send" ? `Send draft ${draftId}` :
      v === "edit" ? `Edit draft ${draftId}` :
      v === "refine" ? `Refine draft ${draftId}` :
      v === "schedule" ? `Schedule draft ${draftId}` :
      `${v} draft ${draftId}`;
    sendToAssistant(followup);
  };

  /** Send a draft directly (bypass agent) for instant, deterministic action. */
  const sendDraftDirect = async (draftId: number, msgIdx: number) => {
    try {
      await api.sendDraft(draftId);
      mutateArtifact(msgIdx, (a) => a.draft_id === draftId, { type: "sent", status: "sent" });
      tts.cancel();
      tts.speak("Sent.");
    } catch (e) {
      tts.speak("Send failed.");
      alert(`Send failed: ${(e as Error).message}`);
    }
  };

  const discardDraftDirect = async (draftId: number, msgIdx: number) => {
    try {
      await api.deleteDraft(draftId);
      mutateArtifact(msgIdx, (a) => a.draft_id === draftId, { status: "cancelled" });
      tts.speak("Discarded.");
    } catch (e) {
      alert(`Discard failed: ${(e as Error).message}`);
    }
  };

  const scheduleDraftDirect = async (draftId: number, minutes: number, msgIdx: number) => {
    try {
      const when = new Date(Date.now() + minutes * 60_000).toISOString();
      await api.updateDraft(draftId, { scheduled_for: when });
      mutateArtifact(msgIdx, (a) => a.draft_id === draftId, {
        type: "scheduled",
        status: "scheduled",
        scheduled_for: when,
      });
      tts.cancel();
      tts.speak(`Scheduled for ${minutes < 60 ? minutes + " minutes" : Math.round(minutes/60) + " hour" + (minutes >= 120 ? "s" : "")}.`);
    } catch (e) {
      alert(`Schedule failed: ${(e as Error).message}`);
    }
  };

  const refineDraftViaAgent = (draftId: number) => {
    // Trigger a turn where the user will dictate the change.
    sendToAssistant(`Refine draft ${draftId}: `);
  };

  // ---------- auto-listen ----------
  const [autoListen, setAutoListen] = useState<boolean>(() => {
    try { return localStorage.getItem("inbox:voice:autolisten") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("inbox:voice:autolisten", autoListen ? "1" : "0"); } catch {}
  }, [autoListen]);
  useEffect(() => {
    if (!autoListen || !stt.supported) return;
    if (tts.speaking || streaming || stt.listening) return;
    // assistant just finished speaking → start listening shortly
    const t = window.setTimeout(() => {
      if (!tts.speaking && !streaming && !stt.listening) stt.start();
    }, 350);
    return () => window.clearTimeout(t);
  }, [autoListen, tts.speaking, streaming, stt.listening, stt.supported, stt.start]);

  const phase: Phase =
    stt.listening ? "listening" :
    streaming ? "thinking" :
    tts.speaking ? "speaking" :
    "idle";

  const lastUser = [...messages].reverse().find((m) => m.role === "user");

  return (
    <div className="voice-shell glass">
      <header className="voice-header">
        <div className="voice-title">
          <h1>Voice mode</h1>
          <p>Hands-free conversation with your assistant · tap the orb to talk</p>
        </div>
        <div className="voice-tools">
          <label className="auto-listen-toggle" title="Automatically start listening when the assistant finishes speaking">
            <input type="checkbox" checked={autoListen} onChange={(e) => setAutoListen(e.target.checked)} />
            <span>Auto-listen</span>
          </label>
          <VoicePicker tts={tts} />
          <button className="clear-btn" onClick={handleClear} title="Clear conversation">
            <span className="clear-icon">🗑</span> Clear
          </button>
        </div>
      </header>

      <div className="voice-stage">
        <button
          className={`voice-orb voice-orb--${phase}`}
          onClick={handleMicClick}
          aria-label={stt.listening ? "Stop listening" : "Start listening"}
          disabled={!stt.supported}
        >
          <span className="orb-core" />
          <span className="orb-ring ring-1" />
          <span className="orb-ring ring-2" />
          <span className="orb-ring ring-3" />
          <span className="orb-glyph">
            {phase === "listening" ? "🎙" :
             phase === "thinking" ? "✨" :
             phase === "speaking" ? "🔊" :
             "🎤"}
          </span>
        </button>

        <div className="voice-state-label">
          {!stt.supported ? "Voice input not supported in this browser." :
           phase === "listening" ? "Listening…" :
           phase === "thinking" ? (toolStatus || "Thinking…") :
           phase === "speaking" ? "Speaking…" :
           "Tap to talk"}
          {stt.error && <span className="voice-error"> · {stt.error}</span>}
        </div>

        <div className="voice-subtitles">
          {(stt.transcript || lastUser?.content) && (
            <div className="sub-line you">
              <span className="sub-label">You</span>
              <span className="sub-text">{stt.transcript || lastUser?.content}</span>
            </div>
          )}
          {subtitleAssistant && (
            <div className="sub-line ai">
              <span className="sub-label">Assistant</span>
              <span className="sub-text">{stripForSpeech(subtitleAssistant)}</span>
            </div>
          )}
        </div>

        {currentInteraction && (
          <InteractionPanel
            messageIndex={currentInteraction.messageIndex}
            artifacts={currentInteraction.artifacts}
            onPickChannel={pickChannel}
            onPickDraft={pickDraft}
            onSendDraft={sendDraftDirect}
            onDiscardDraft={discardDraftDirect}
            onScheduleDraft={scheduleDraftDirect}
            onRefineDraft={refineDraftViaAgent}
          />
        )}
      </div>

      <div className="voice-controls">
        {tts.speaking && (
          <button className="ghost-btn" onClick={handleStopSpeaking}>⏹ Stop speaking</button>
        )}
        {!stt.supported && (
          <div className="voice-fallback">
            Try Chrome, Edge, or Safari. Firefox doesn't support SpeechRecognition.
            Use the text Assistant view instead.
          </div>
        )}
      </div>
    </div>
  );
}


// ---------- Interaction Panel ----------
// Renders the assistant's latest artifacts as big tap-friendly options.
// The user can also speak their choice — the agent handles natural language too.

const SCHEDULE_PRESETS: { label: string; minutes: number }[] = [
  { label: "in 5 min", minutes: 5 },
  { label: "in 30 min", minutes: 30 },
  { label: "in 1 hr", minutes: 60 },
  { label: "in 4 hr", minutes: 240 },
];

interface InteractionPanelProps {
  messageIndex: number;
  artifacts: ChatArtifact[];
  onPickChannel: (channelName: string, intent: string, msgIdx: number) => void;
  onPickDraft: (draftId: number, verb: string, msgIdx: number) => void;
  onSendDraft: (draftId: number, msgIdx: number) => void;
  onDiscardDraft: (draftId: number, msgIdx: number) => void;
  onScheduleDraft: (draftId: number, minutes: number, msgIdx: number) => void;
  onRefineDraft: (draftId: number) => void;
}

function InteractionPanel(p: InteractionPanelProps) {
  const { messageIndex, artifacts } = p;
  return (
    <div className="voice-interactions">
      {artifacts.map((a, i) => {
        if (a.type === "channel_picker" && a.channels) {
          if (a.picked) {
            return (
              <div key={i} className="vi-resolved">
                ✓ {a.intent} <strong>#{a.picked}</strong>
              </div>
            );
          }
          return (
            <div key={i} className="vi-card">
              <div className="vi-head">
                <span className="vi-title">Pick a channel to {a.intent}</span>
                <span className="vi-hint">Tap, or say a channel name</span>
              </div>
              <div className="vi-grid">
                {a.channels.map((c) => (
                  <button
                    key={c.channel_pk}
                    className="vi-chip"
                    onClick={() => p.onPickChannel(c.name, a.intent || "use", messageIndex)}
                  >
                    <span className="vi-chip-glyph">{c.is_dm ? "@" : "#"}</span>{c.name}
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
              <div key={i} className="vi-resolved">
                ✓ {verb} draft <strong>#{a.picked}</strong>
              </div>
            );
          }
          if (a.drafts.length === 0) {
            return (
              <div key={i} className="vi-card empty">
                <span className="vi-title">No drafts to {verb}.</span>
              </div>
            );
          }
          return (
            <div key={i} className="vi-card">
              <div className="vi-head">
                <span className="vi-title">Pick a draft to {verb}</span>
                <span className="vi-hint">Tap one, or say its number</span>
              </div>
              <div className="vi-stack">
                {a.drafts.map((d) => (
                  <button
                    key={d.draft_id}
                    className="vi-row"
                    onClick={() => p.onPickDraft(d.draft_id, verb, messageIndex)}
                  >
                    <div className="vi-row-meta">
                      <span className="vi-chip-glyph">{d.is_dm ? "@" : "#"}{d.channel}</span>
                      <span className="vi-row-status">
                        {d.status === "scheduled" && d.scheduled_for
                          ? `⏱ ${new Date(d.scheduled_for).toLocaleString()}`
                          : d.status}
                      </span>
                      <span className="vi-row-id">#{d.draft_id}</span>
                    </div>
                    <div className="vi-row-body">{d.body_preview}</div>
                  </button>
                ))}
              </div>
            </div>
          );
        }
        if (a.type === "draft" && a.draft_id && a.body) {
          return (
            <div key={i} className="vi-card draft-card">
              <div className="vi-head">
                <span className="vi-title">Draft for #{a.channel}</span>
                <span className="vi-id">#{a.draft_id}</span>
              </div>
              <div className="vi-draft-body">"{a.body}"</div>
              <div className="vi-actions">
                <button className="vi-act primary" onClick={() => p.onSendDraft(a.draft_id!, messageIndex)}>
                  Send
                </button>
                <div className="vi-schedule">
                  {SCHEDULE_PRESETS.map((s) => (
                    <button
                      key={s.minutes}
                      className="vi-act small"
                      onClick={() => p.onScheduleDraft(a.draft_id!, s.minutes, messageIndex)}
                    >
                      ⏱ {s.label}
                    </button>
                  ))}
                </div>
                <button className="vi-act ghost" onClick={() => p.onRefineDraft(a.draft_id!)}>
                  ↻ Refine
                </button>
                <button className="vi-act danger" onClick={() => p.onDiscardDraft(a.draft_id!, messageIndex)}>
                  Discard
                </button>
              </div>
              <div className="vi-hint">
                Tap, or say "send" / "schedule in 30 minutes" / "refine" / "discard"
              </div>
            </div>
          );
        }
        if (a.type === "sent" && a.draft_id) {
          return (
            <div key={i} className="vi-resolved sent">
              ✓ Sent {a.channel ? `to #${a.channel}` : ""}
            </div>
          );
        }
        if (a.type === "scheduled" && a.draft_id) {
          return (
            <div key={i} className="vi-resolved scheduled">
              ⏱ Scheduled draft #{a.draft_id}
              {a.scheduled_for && (
                <span className="vi-when"> for {new Date(a.scheduled_for).toLocaleString()}</span>
              )}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}


function VoicePicker({ tts }: { tts: ReturnType<typeof useSpeechSynthesis> }) {
  const englishVoices = tts.voices.filter((v) => /^en/i.test(v.lang));
  return (
    <div className="voice-picker">
      <select
        value={tts.voiceURI ?? ""}
        onChange={(e) => tts.setVoiceURI(e.target.value || null)}
        title="Pick a voice"
      >
        <option value="">Default voice</option>
        {englishVoices.map((v) => (
          <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>
        ))}
      </select>
      <label className="rate-control" title="Speech rate">
        <span>Rate</span>
        <input
          type="range"
          min="0.6"
          max="1.6"
          step="0.05"
          value={tts.rate}
          onChange={(e) => tts.setRate(parseFloat(e.target.value))}
        />
        <span className="rate-val">{tts.rate.toFixed(2)}×</span>
      </label>
    </div>
  );
}
