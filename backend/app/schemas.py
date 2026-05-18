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
