import type { ActivitySnapshot } from "../types";

interface Props {
  snapshot: ActivitySnapshot | null;
  loading: boolean;
  onRefresh: () => void;
  onAsk: (prompt: string) => void;
}

function relWhen(iso: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms < 0) {
    const m = Math.round(-ms / 60000);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  }
  const m = Math.round(ms / 60000);
  if (m < 60) return `in ${m}m`;
  return `in ${Math.round(m / 60)}h`;
}

export function ActivityRail({ snapshot, loading, onRefresh, onAsk }: Props) {
  return (
    <div className="rail">
      <div className="rail-section">
        <div className="rail-head">
          <h3>Activity</h3>
          <button className="link-btn" onClick={onRefresh} disabled={loading}>
            {loading ? "…" : "↻"}
          </button>
        </div>
        {!snapshot || snapshot.channels.length === 0 ? (
          <div className="rail-empty">{loading ? "Loading…" : "Quiet across all channels."}</div>
        ) : (
          snapshot.channels.map((c) => (
            <div key={c.channel_pk} className="rail-card">
              <div className="rail-card-head">
                <span className="rail-channel">{c.is_dm ? "@" : "#"}{c.name}</span>
                <span className="rail-count">{c.unread} new</span>
              </div>
              <div className="rail-preview">
                {c.last_user && <span className="rail-author">{c.last_user}: </span>}
                {c.last_preview || "(no text)"}
              </div>
              <div className="rail-actions">
                <button className="chip-action" onClick={() => onAsk(`Summarize #${c.name}`)}>
                  Summarize
                </button>
                <button className="chip-action" onClick={() => onAsk(`Draft a reply in #${c.name}`)}>
                  Draft reply
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {snapshot && snapshot.drafts.length > 0 && (
        <div className="rail-section">
          <div className="rail-head">
            <h3>Scheduled & drafts</h3>
          </div>
          {snapshot.drafts.map((d) => (
            <div key={d.draft_id} className="rail-card">
              <div className="rail-card-head">
                <span className="rail-channel">#{d.channel}</span>
                <span className={`rail-status status-${d.status}`}>
                  {d.status === "scheduled" && d.scheduled_for
                    ? `⏱ ${relWhen(d.scheduled_for)}`
                    : d.status}
                </span>
              </div>
              <div className="rail-preview">{d.body_preview}</div>
              <div className="rail-actions">
                {d.status === "scheduled" ? (
                  <button className="chip-action" onClick={() => onAsk(`Cancel scheduled draft ${d.draft_id}`)}>
                    Cancel
                  </button>
                ) : (
                  <button className="chip-action" onClick={() => onAsk(`Send draft ${d.draft_id}`)}>
                    Send now
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
