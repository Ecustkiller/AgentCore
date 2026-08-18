"""IM person-side DTOs derive avatar_url the same way as /me.

Assembled only at the five messaging route helpers; message bodies and thin
events stay avatar-free. No DB — helpers take a User-shaped namespace.
"""

from types import SimpleNamespace

from agentcore.api.routes.messages import (
    _blocked_user,
    _friend_summary,
    _participant,
    _search_result,
    _user_profile,
)
from agentcore.api.schemas import (
    BlockedUser,
    ChatMessageDetail,
    ChatParticipant,
    FriendSummary,
    PersonPublic,
    ReplyToSnapshot,
    UserProfile,
    UserSearchResult,
)
from agentcore.api.schemas._helpers import _avatar_url
from agentcore.api.schemas.messaging import BetaGroupModerator
from agentcore.messaging import ProfileView
from agentcore.messaging.presence import presence_event

USER_ID = "11111111-1111-1111-1111-111111111111"
AVATAR_KEY = f"avatars/{USER_ID}/deadbeefcafebabe.webp"


def _user(*, avatar_key: str | None) -> SimpleNamespace:
    return SimpleNamespace(
        user_id=USER_ID,
        username="alice",
        display_name="Alice",
        avatar_key=avatar_key,
    )


def _assemble_all(user: SimpleNamespace):
    view = ProfileView(user=user, relation="none", request_id=None)
    return (
        _participant(user),
        _search_result(user),
        _blocked_user(user),
        _friend_summary(user),
        _user_profile(view),
    )


def test_person_dtos_inherit_optional_avatar_url():
    for cls in (
        ChatParticipant,
        UserProfile,
        FriendSummary,
        UserSearchResult,
        BlockedUser,
    ):
        assert issubclass(cls, PersonPublic)
        field = cls.model_fields["avatar_url"]
        assert field.annotation == str | None
        assert field.default is None


def test_person_dtos_avatar_url_from_key():
    expected = _avatar_url(USER_ID, AVATAR_KEY)
    assert expected is not None
    assert "?v=" in expected
    assert expected.startswith(f"/v1/users/{USER_ID}/avatar")
    for dto in _assemble_all(_user(avatar_key=AVATAR_KEY)):
        assert dto.avatar_url == expected


def test_person_dtos_avatar_url_null_without_key():
    for dto in _assemble_all(_user(avatar_key=None)):
        assert dto.avatar_url is None


def test_message_and_thin_events_omit_avatar():
    assert "avatar_url" not in ChatMessageDetail.model_fields
    assert "avatar_url" not in ReplyToSnapshot.model_fields
    assert "avatar_url" not in presence_event(user_id="u1", online=True)
    # Admin 版主任命表 stays out of this knife.
    assert not issubclass(BetaGroupModerator, PersonPublic)
    assert "avatar_url" not in BetaGroupModerator.model_fields
