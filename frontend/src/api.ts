import type { Channel, Message, Summary } from "./types";

async function jsonOrThrow<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

export const api = {
  channels: () => fetch("/slack/channels").then(jsonOrThrow<Channel[]>),
  messages: (channelPk: number, limit = 50) =>
    fetch(`/slack/channels/${channelPk}/messages?limit=${limit}`).then(jsonOrThrow<Message[]>),
  summarize: (channelPk: number, limit = 50) =>
    fetch(`/slack/channels/${channelPk}/summary?limit=${limit}`, { method: "POST" }).then(
      jsonOrThrow<Summary>,
    ),
  syncNow: () => fetch("/slack/sync", { method: "POST" }).then(jsonOrThrow<{ new_messages: number }>),
};
