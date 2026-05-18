import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { Channel, Draft } from "../types";

interface ComposerProps {
  channel: Channel;
  onSent: () => void;
  /** Scheduled / draft rows for this channel, for the chips strip. */
  drafts: Draft[];
  /** Refresh drafts after a mutation. */
  refreshDrafts: () => void;
}

const SCHEDULE_PRESETS: { label: string; minutes: number }[] = [
  { label: "in 5 min", minutes: 5 },
  { label: "in 15 min", minutes: 15 },
  { label: "in 1 hour", minutes: 60 },
  { label: "in 4 hours", minutes: 240 },
  { label: "tomorrow 9am", minutes: -1 }, // computed specially
];

function tomorrow9amISO(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

function localDatetimeValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function relativeWhen(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms < 0) return "due now";
  const m = Math.round(ms / 60000);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h}h`;
  const d = Math.round(h / 24);
  return `in ${d}d`;
}

export function Composer({ channel, onSent, drafts, refreshDrafts }: ComposerProps) {
  const [body, setBody] = useState("");
  const [intent, setIntent] = useState("");
  const [showIntent, setShowIntent] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [phase, setPhase] = useState<"summary" | "draft" | null>(null);
  const [draftId, setDraftId] = useState<number | null>(null);
  const [scheduledFor, setScheduledFor] = useState<string | null>(null);
  const [showSchedule, setShowSchedule] = useState(false);
  const [customWhen, setCustomWhen] = useState("");
  const [sending, setSending] = useState(false);

  const ctrlRef = useRef<AbortController | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Reset composer when channel changes
  useEffect(() => {
    ctrlRef.current?.abort();
    setBody("");
    setIntent("");
    setShowIntent(false);
    setDraftId(null);
    setScheduledFor(null);
    setShowSchedule(false);
    setDrafting(false);
    setPhase(null);
  }, [channel.id]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(Math.max(ta.scrollHeight, 44), 220) + "px";
  }, [body]);

  const scheduled = useMemo(
    () => drafts.filter((d) => d.status === "scheduled").sort((a, b) =>
      (a.scheduled_for || "").localeCompare(b.scheduled_for || ""),
    ),
    [drafts],
  );

  const startAiDraft = () => {
    ctrlRef.current?.abort();
    setBody("");
    setDrafting(true);
    setPhase("summary");
    setDraftId(null);
    setScheduledFor(null);
    ctrlRef.current = api.draftFromChannel(channel.id, intent.trim(), {
      onPhase: (p) => setPhase(p),
      onDraftChunk: (text) => setBody((b) => b + text),
      onSaved: (id, fullBody) => {
        setDraftId(id);
        if (fullBody) setBody(fullBody);
      },
      onDone: () => {
        setDrafting(false);
        setPhase(null);
        refreshDrafts();
      },
      onError: (err) => {
        setDrafting(false);
        setPhase(null);
        setBody((b) => b + `\n[draft failed: ${err}]`);
      },
    });
  };

  const cancelDraft = () => {
    ctrlRef.current?.abort();
    setDrafting(false);
    setPhase(null);
  };

  const clearComposer = () => {
    setBody("");
    setDraftId(null);
    setScheduledFor(null);
    setShowSchedule(false);
    setIntent("");
    setShowIntent(false);
  };

  const ensureDraft = useCallback(async (): Promise<number> => {
    if (draftId != null) {
      await api.updateDraft(draftId, { body });
      return draftId;
    }
    const d = await api.createDraft(channel.id, body);
    setDraftId(d.id);
    return d.id;
  }, [draftId, body, channel.id]);

  const sendNow = async () => {
    if (!body.trim() || sending) return;
    setSending(true);
    try {
      if (draftId != null) {
        await api.sendDraft(draftId);
      } else {
        await api.quickSend(channel.id, body);
      }
      clearComposer();
      onSent();
      refreshDrafts();
    } catch (e) {
      alert(`Send failed: ${(e as Error).message}`);
    } finally {
      setSending(false);
    }
  };

  const scheduleAt = async (iso: string) => {
    if (!body.trim()) return;
    try {
      const id = await ensureDraft();
      await api.updateDraft(id, { body, scheduled_for: iso });
      setScheduledFor(iso);
      setShowSchedule(false);
      refreshDrafts();
    } catch (e) {
      alert(`Schedule failed: ${(e as Error).message}`);
    }
  };

  const unschedule = async () => {
    if (draftId == null) return;
    await api.updateDraft(draftId, { unschedule: true });
    setScheduledFor(null);
    refreshDrafts();
  };

  const refine = async () => {
    const instruction = window.prompt(
      "How should the draft change? (e.g. 'make it shorter', 'more casual', 'add an ETA ask')",
    );
    if (!instruction) return;
    try {
      let id = draftId;
      if (id == null) id = await ensureDraft();
      const updated = await api.refineDraft(id, instruction);
      setBody(updated.body);
      refreshDrafts();
    } catch (e) {
      alert(`Refine failed: ${(e as Error).message}`);
    }
  };

  const loadScheduled = (d: Draft) => {
    ctrlRef.current?.abort();
    setBody(d.body);
    setDraftId(d.id);
    setScheduledFor(d.scheduled_for);
    setDrafting(false);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendNow();
    }
  };

  return (
    <div className="composer">
      {scheduled.length > 0 && (
        <div className="scheduled-strip">
          <span className="strip-label">Scheduled</span>
          {scheduled.map((d) => (
            <button
              key={d.id}
              className={`chip ${d.id === draftId ? "active" : ""}`}
              onClick={() => loadScheduled(d)}
              title={new Date(d.scheduled_for!).toLocaleString()}
            >
              <span className="chip-clock">⏱</span>
              <span className="chip-when">{relativeWhen(d.scheduled_for!)}</span>
              <span className="chip-preview">{d.body.slice(0, 38)}{d.body.length > 38 ? "…" : ""}</span>
            </button>
          ))}
        </div>
      )}

      {showIntent && (
        <input
          className="intent-input"
          placeholder="Optional intent — e.g. 'acknowledge and ask for ETA'"
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); startAiDraft(); } }}
        />
      )}

      <div className="composer-row">
        <button
          className={`sparkle ${drafting ? "active" : ""}`}
          onClick={drafting ? cancelDraft : startAiDraft}
          title={drafting ? "Cancel AI draft" : "Draft with AI from recent messages"}
        >
          {drafting ? <span className="spinner" /> : "✨"}
        </button>

        <textarea
          ref={taRef}
          className="composer-input"
          placeholder={
            drafting
              ? phase === "summary"
                ? "Reading the channel…"
                : "Writing reply…"
              : `Message #${channel.name} — ⌘↵ to send`
          }
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKey}
          rows={1}
        />

        <div className="composer-actions">
          <button
            className="ghost-btn"
            onClick={() => setShowIntent((s) => !s)}
            title="Add a hint for the AI"
          >
            {showIntent ? "Hide hint" : "+ Hint"}
          </button>
          {draftId != null && body.trim() && (
            <button className="ghost-btn" onClick={refine} title="Ask AI to rewrite this draft">
              ↻ Refine
            </button>
          )}
        </div>
      </div>

      <div className="send-row">
        {scheduledFor && (
          <div className="schedule-pill">
            ⏱ Scheduled for {new Date(scheduledFor).toLocaleString()}
            <button className="link-btn" onClick={unschedule}>cancel</button>
          </div>
        )}

        <div className="send-cluster">
          <button
            className="btn-glow"
            disabled={!body.trim() || sending}
            onClick={sendNow}
          >
            {sending ? <><span className="spinner" /> Sending…</> : "Send"}
          </button>
          <button
            className="btn-ghost-pill"
            onClick={() => setShowSchedule((s) => !s)}
            disabled={!body.trim()}
            title="Schedule send"
          >
            ⏱
          </button>
        </div>

        {showSchedule && (
          <div className="schedule-popover" onClick={(e) => e.stopPropagation()}>
            {SCHEDULE_PRESETS.map((p) => (
              <button
                key={p.label}
                className="schedule-option"
                onClick={() => {
                  const iso =
                    p.minutes === -1
                      ? tomorrow9amISO()
                      : new Date(Date.now() + p.minutes * 60000).toISOString();
                  scheduleAt(iso);
                }}
              >
                {p.label}
              </button>
            ))}
            <div className="schedule-custom">
              <input
                type="datetime-local"
                value={customWhen || (scheduledFor ? localDatetimeValue(scheduledFor) : "")}
                onChange={(e) => setCustomWhen(e.target.value)}
              />
              <button
                className="ghost-btn"
                onClick={() => {
                  if (!customWhen) return;
                  scheduleAt(new Date(customWhen).toISOString());
                }}
              >
                Set
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
