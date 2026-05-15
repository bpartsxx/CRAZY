from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..ws_manager import manager

router = APIRouter()


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await manager.connect(ws)
    try:
        while True:
            # We don't expect inbound messages yet; just keep the socket alive.
            await ws.receive_text()
    except WebSocketDisconnect:
        await manager.disconnect(ws)
