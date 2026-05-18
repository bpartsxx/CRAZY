from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


class SlackAccount(Base):
    """A connected Slack workspace. Single-user app, but supports multiple workspaces."""
    __tablename__ = "slack_accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    team_id: Mapped[str] = mapped_column(String, unique=True, index=True)
    team_name: Mapped[str] = mapped_column(String)
    access_token: Mapped[str] = mapped_column(String)
    token_type: Mapped[str] = mapped_column(String, default="bot")  # "bot" or "user"
    authed_user_id: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    channels: Mapped[list["SlackChannel"]] = relationship(back_populates="account", cascade="all, delete-orphan")


class SlackChannel(Base):
    __tablename__ = "slack_channels"
    __table_args__ = (UniqueConstraint("account_id", "channel_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("slack_accounts.id"))
    channel_id: Mapped[str] = mapped_column(String, index=True)
    name: Mapped[str] = mapped_column(String)
    is_private: Mapped[bool] = mapped_column(default=False)
    is_im: Mapped[bool] = mapped_column(default=False)
    last_polled_ts: Mapped[str | None] = mapped_column(String, nullable=True)

    account: Mapped[SlackAccount] = relationship(back_populates="channels")
    messages: Mapped[list["SlackMessage"]] = relationship(back_populates="channel", cascade="all, delete-orphan")


class SlackMessage(Base):
    __tablename__ = "slack_messages"
    __table_args__ = (UniqueConstraint("channel_pk", "ts"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    channel_pk: Mapped[int] = mapped_column(ForeignKey("slack_channels.id"), index=True)
    ts: Mapped[str] = mapped_column(String, index=True)  # Slack's message timestamp (also its ID)
    user_id: Mapped[str | None] = mapped_column(String, nullable=True)
    user_name: Mapped[str | None] = mapped_column(String, nullable=True)
    text: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    channel: Mapped[SlackChannel] = relationship(back_populates="messages")


class MessageDraft(Base):
    """An AI-drafted (or user-typed) outbound message awaiting send or scheduled.

    status flow: draft -> scheduled -> sent
                              `--> cancelled
                              `--> failed
    """
    __tablename__ = "message_drafts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    channel_pk: Mapped[int] = mapped_column(ForeignKey("slack_channels.id"), index=True)
    body: Mapped[str] = mapped_column(Text, default="")
    source_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String, default="draft", index=True)
    scheduled_for: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    sent_ts: Mapped[str | None] = mapped_column(String, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
