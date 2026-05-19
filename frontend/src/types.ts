export interface Channel {
  id: number;
  channel_id: string;
  name: string;
  is_private: boolean;
  is_im: boolean;
}

export interface Message {
  id: number;
  ts: string;
  user_id: string | null;
  user_name: string | null;
  text: string;
  created_at: string;
}

export interface Summary {
  channel_id: string;
  summary: string;
  message_count: number;
}

export type DraftStatus = "draft" | "scheduled" | "sent" | "cancelled" | "failed";

export interface Draft {
  id: number;
  channel_pk: number;
  body: string;
  source_summary: string | null;
  status: DraftStatus;
  scheduled_for: string | null;
  sent_at: string | null;
  sent_ts: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SlackMessageEvent {
  type: "slack.message";
  account_id: number;
  channel_pk: number;
  channel_name: string;
  message: {
    id: number;
    ts: string;
    user_name: string | null;
    text: string;
  };
}

export interface DraftSentEvent {
  type: "draft.sent";
  draft_id: number;
  channel_pk: number;
  sent_ts: string;
  scheduled?: boolean;
}

export interface DraftFailedEvent {
  type: "draft.failed";
  draft_id: number;
  channel_pk: number;
  error: string;
}

export type WsEvent = SlackMessageEvent | DraftSentEvent | DraftFailedEvent;


// ---------- Assistant chat ----------

export type ChatRole = "user" | "assistant" | "tool" | "system";

export interface ToolCallRef {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChannelPickerOption {
  channel_pk: number;
  name: string;
  is_dm: boolean;
}

export interface DraftPickerOption {
  draft_id: number;
  channel: string;
  is_dm: boolean;
  body_preview: string;
  status: string;
  scheduled_for: string | null;
}

export interface ChatArtifact {
  type: "draft" | "sent" | "scheduled" | "channel_picker" | "draft_picker";
  draft_id?: number;
  channel?: string;
  channel_pk?: number;
  body?: string;
  scheduled_for?: string;
  ts?: string;
  status?: string;
  /** channel_picker only */
  intent?: string;
  channels?: ChannelPickerOption[];
  /** draft_picker only */
  verb?: string;
  drafts?: DraftPickerOption[];
  /** Set once the user clicks a chip, so we don't render again. */
  picked?: string;
}

export interface ChatToolEvent {
  id: string;
  name: string;
  status: "running" | "done";
  input?: unknown;
  output?: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Tool calls the assistant made (assistant role only). */
  tool_calls?: ToolCallRef[];
  /** Linked tool call id (tool role only). */
  tool_call_id?: string;
  /** Tool name (tool role only). */
  name?: string;
  /** Inline visualization of tool runs that happened during this turn. */
  tool_events?: ChatToolEvent[];
  /** Structured artifacts surfaced from tool outputs. */
  artifacts?: ChatArtifact[];
}

export interface ActivityChannel {
  channel_pk: number;
  name: string;
  is_dm: boolean;
  unread: number;
  last_preview: string;
  last_user: string | null;
  last_ts: string | null;
}

export interface ActivityDraft {
  draft_id: number;
  channel: string;
  body_preview: string;
  status: string;
  scheduled_for: string | null;
}

export interface ActivitySnapshot {
  channels: ActivityChannel[];
  drafts: ActivityDraft[];
}
