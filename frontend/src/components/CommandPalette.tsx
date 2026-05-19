import { useEffect, useRef, useState } from "react";

export interface PaletteCommand {
  trigger: string;            // e.g. "/summarize"
  label: string;              // user-facing label
  description: string;        // one-line help text
  template: string;           // text inserted into the input on pick
}

export const DEFAULT_COMMANDS: PaletteCommand[] = [
  {
    trigger: "/whatsnew",
    label: "What's new",
    description: "Get a snapshot of recent activity across all channels",
    template: "What's new across my channels?",
  },
  {
    trigger: "/summarize",
    label: "Summarize a channel",
    description: "Summarize recent messages in a specific channel",
    template: "Summarize #",
  },
  {
    trigger: "/draft",
    label: "Draft a reply",
    description: "Draft a reply in a channel (review before sending)",
    template: "Draft a reply in #",
  },
  {
    trigger: "/schedule",
    label: "Schedule a message",
    description: "Schedule a draft to send later",
    template: "Schedule the last draft for ",
  },
  {
    trigger: "/drafts",
    label: "List my drafts",
    description: "Show all draft and scheduled messages",
    template: "List my scheduled messages",
  },
  {
    trigger: "/cancel",
    label: "Cancel a scheduled send",
    description: "Cancel a scheduled message",
    template: "Cancel scheduled draft ",
  },
];

interface Props {
  query: string;
  onPick: (cmd: PaletteCommand) => void;
  onDismiss: () => void;
}

export function CommandPalette({ query, onPick, onDismiss }: Props) {
  const [active, setActive] = useState(0);
  const filtered = DEFAULT_COMMANDS.filter((c) =>
    c.trigger.includes(query.toLowerCase()) ||
    c.label.toLowerCase().includes(query.toLowerCase().replace("/", "")),
  );
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { setActive(0); }, [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (filtered[active]) onPick(filtered[active]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [filtered, active, onPick, onDismiss]);

  if (filtered.length === 0) return null;

  return (
    <div className="palette" ref={ref}>
      <div className="palette-hint">Commands · ↑↓ to navigate · ↵ to pick · Esc to close</div>
      {filtered.map((c, i) => (
        <button
          key={c.trigger}
          className={`palette-item ${i === active ? "active" : ""}`}
          onMouseEnter={() => setActive(i)}
          onClick={() => onPick(c)}
        >
          <span className="palette-trigger">{c.trigger}</span>
          <span className="palette-label">{c.label}</span>
          <span className="palette-desc">{c.description}</span>
        </button>
      ))}
    </div>
  );
}
