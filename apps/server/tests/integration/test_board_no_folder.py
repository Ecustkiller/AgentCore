"""Boards are account-scoped: create ignores folder_id."""

from sqlalchemy import update

from agentcore.db.models import Board
from agentcore.db.repositories import FolderRepository
from tests.integration.conftest import register_and_login


async def test_create_board_ignores_folder_id(client, session_factory):
    uid = await register_and_login(client, "boardnf")
    async with session_factory() as s:
        desk = await FolderRepository(s).create(user_id=uid, name="Desk")
        desk_id = desk.id

    created = await client.post(
        "/v1/boards", json={"title": "t", "folder_id": desk_id}
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert "folder_id" not in body
    assert "conversation_id" not in body
    board_id = body["id"]

    async with session_factory() as s:
        board = await s.get(Board, board_id)
        assert board is not None
        assert board.folder_id is None
        await s.execute(
            update(Board).where(Board.id == board_id).values(folder_id=desk_id)
        )
        await s.commit()

    listed = await client.get("/v1/boards")
    assert listed.status_code == 200, listed.text
    row = next(b for b in listed.json() if b["id"] == board_id)
    assert "folder_id" not in row
    assert "conversation_id" not in row
