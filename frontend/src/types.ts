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
