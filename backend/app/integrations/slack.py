"""Thin wrapper around the Slack Web API.

Single-user app: we keep one access token per workspace in `slack_accounts`.
Use a User token (xoxp-) if you want to read all channels you're in without
having to invite a bot. Use a Bot token (xoxb-) for the standard app pattern.
"""
from __future__ import annotations

import httpx

SLACK_API = "https://slack.com/api"


class SlackError(Exception):
    pass


class SlackClient:
    def __init__(self, token: str):
        self.token = token
        self._http = httpx.AsyncClient(
            base_url=SLACK_API,
            headers={"Authorization": f"Bearer {token}"},
            timeout=20.0,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _get(self, path: str, params: dict | None = None) -> dict:
        r = await self._http.get(path, params=params or {})
        r.raise_for_status()
        data = r.json()
        if not data.get("ok"):
            raise SlackError(data.get("error", "unknown_slack_error"))
        return data

    async def auth_test(self) -> dict:
        return await self._get("/auth.test")

    async def list_channels(self, types: str = "public_channel,private_channel,im") -> list[dict]:
        out: list[dict] = []
        cursor: str | None = None
        while True:
            params = {"types": types, "limit": 200, "exclude_archived": "true"}
            if cursor:
                params["cursor"] = cursor
            data = await self._get("/conversations.list", params=params)
            out.extend(data.get("channels", []))
            cursor = data.get("response_metadata", {}).get("next_cursor") or None
            if not cursor:
                return out

    async def fetch_history(
        self,
        channel_id: str,
        oldest: str | None = None,
        limit: int = 50,
    ) -> list[dict]:
        params: dict = {"channel": channel_id, "limit": limit}
        if oldest:
            params["oldest"] = oldest
        data = await self._get("/conversations.history", params=params)
        return data.get("messages", [])

    async def get_user(self, user_id: str) -> dict | None:
        try:
            data = await self._get("/users.info", params={"user": user_id})
            return data.get("user")
        except SlackError:
            return None

    async def post_message(self, channel: str, text: str, thread_ts: str | None = None) -> dict:
        """Send a message. Requires the chat:write scope on the token."""
        payload: dict = {"channel": channel, "text": text}
        if thread_ts:
            payload["thread_ts"] = thread_ts
        r = await self._http.post("/chat.postMessage", json=payload)
        r.raise_for_status()
        data = r.json()
        if not data.get("ok"):
            raise SlackError(data.get("error", "post_message_failed"))
        return data


async def exchange_oauth_code(client_id: str, client_secret: str, code: str, redirect_uri: str) -> dict:
    """Exchange an OAuth v2 code for an access token."""
    async with httpx.AsyncClient(timeout=20.0) as http:
        r = await http.post(
            f"{SLACK_API}/oauth.v2.access",
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "code": code,
                "redirect_uri": redirect_uri,
            },
        )
        r.raise_for_status()
        data = r.json()
        if not data.get("ok"):
            raise SlackError(data.get("error", "oauth_failed"))
        return data
