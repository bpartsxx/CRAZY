from datetime import datetime

from pydantic import BaseModel, ConfigDict


class ChannelOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    channel_id: str
    name: str
    is_private: bool
    is_im: bool


class MessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    ts: str
    user_id: str | None
    user_name: str | None
    text: str
    created_at: datetime


class SummaryOut(BaseModel):
    channel_id: str
    summary: str
    message_count: int


class AccountOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    team_id: str
    team_name: str


# ---------- Drafts ----------


class DraftOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    channel_pk: int
    body: str
    source_summary: str | None
    status: str
    scheduled_for: datetime | None
    sent_at: datetime | None
    sent_ts: str | None
    error: str | None
    created_at: datetime
    updated_at: datetime


class DraftCreateIn(BaseModel):
    channel_pk: int
    body: str = ""
    scheduled_for: datetime | None = None
    source_summary: str | None = None


class DraftUpdateIn(BaseModel):
    body: str | None = None
    scheduled_for: datetime | None = None
    unschedule: bool = False


class DraftFromChannelIn(BaseModel):
    intent: str | None = None
    message_limit: int = 50


class RefineIn(BaseModel):
    instruction: str


class QuickSendIn(BaseModel):
    channel_pk: int
    body: str


# ---------- Assistant chat ----------


class ChatHistoryItem(BaseModel):
    role: str  # "user" | "assistant" | "tool"
    content: str
    tool_calls: list[dict] | None = None
    tool_call_id: str | None = None
    name: str | None = None


class ChatIn(BaseModel):
    message: str
    history: list[ChatHistoryItem] = []


class ActivityChannel(BaseModel):
    channel_pk: int
    name: str
    is_dm: bool
    unread: int
    last_preview: str
    last_user: str | None
    last_ts: str | None


class ActivityDraft(BaseModel):
    draft_id: int
    channel: str
    body_preview: str
    status: str
    scheduled_for: datetime | None


class ActivityOut(BaseModel):
    channels: list[ActivityChannel]
    drafts: list[ActivityDraft]
