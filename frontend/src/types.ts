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
