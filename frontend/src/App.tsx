import { useEffect, useState } from "react";
import { AssistantView } from "./components/AssistantView";
import { InboxView } from "./components/InboxView";

type View = "assistant" | "inbox";

const NAV_KEY = "inbox:view:v1";

// Voice mode is no longer a top-level view — it lives inside the Chat view
// as a collapsible right-rail panel with its own conversation thread.
const TABS: { id: View; icon: string; label: string }[] = [
  { id: "assistant", icon: "✨", label: "Chat" },
  { id: "inbox",     icon: "💬", label: "Inbox" },
];

export default function App() {
  const [view, setView] = useState<View>(() => {
    const stored = (typeof localStorage !== "undefined" ? localStorage.getItem(NAV_KEY) : null) as View | null;
    return stored && TABS.some((t) => t.id === stored) ? stored : "assistant";
  });

  useEffect(() => {
    try { localStorage.setItem(NAV_KEY, view); } catch {}
  }, [view]);

  return (
    <div className="root-shell">
      <aside className="root-nav glass">
        <div className="brand">
          <span className="brand-mark" />
          <span className="brand-name">Inbox</span>
        </div>
        <nav className="root-nav-items">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`root-nav-item ${view === t.id ? "active" : ""}`}
              onClick={() => setView(t.id)}
              title={t.label}
            >
              <span className="root-nav-icon">{t.icon}</span>
              <span className="root-nav-label">{t.label}</span>
            </button>
          ))}
          <div className="root-nav-item disabled" title="Coming soon">
            <span className="root-nav-icon">📥</span>
            <span className="root-nav-label">Gmail</span>
          </div>
          <div className="root-nav-item disabled" title="Coming soon">
            <span className="root-nav-icon">📱</span>
            <span className="root-nav-label">WhatsApp</span>
          </div>
        </nav>
        <div className="root-nav-foot">
          <div className="root-nav-hint">v0.3 · voice</div>
        </div>
      </aside>

      <div className="root-view">
        {view === "assistant" ? <AssistantView /> : <InboxView />}
      </div>
    </div>
  );
}
