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
