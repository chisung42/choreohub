"""ChoreoHub 협업 데이터 저장소.

여러 사용자가 같은 작업을 함께 보려면 상태가 앱 메모리가 아니라 서버에 있어야 한다.
해커톤 범위에서 운영 부담 없이 쓰려고 표준 라이브러리 sqlite3 만 사용한다.

**신원은 가볍다.** 비밀번호가 없고, 처음 접속할 때 표시 이름을 받아 사용자 행을 만들고
그 `user_id` 를 클라이언트가 보관한다. 즉 `user_id` 를 아는 사람은 그 사람으로 행동할 수
있다 — 데모용이며, 공개 배포 전에 실제 인증으로 바꿔야 한다.

포즈 좌표는 행에 넣지 않는다. 60초 영상이 8MB 가 넘어 SQLite 에 넣을 이유가 없고, 이미
`uploads/<해시>.*` 로 디스크에 있으므로 프로젝트 행은 `source_sha256` 으로 가리킨다.
"""

from __future__ import annotations

import json
import secrets
import sqlite3
import threading
import time
import uuid
from pathlib import Path

DB_PATH = Path(__file__).parent / "choreohub.db"
PERMISSIONS = ("보기만", "수정 제안", "직접 수정")

_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  owner_id      TEXT NOT NULL REFERENCES users(id),
  license       TEXT NOT NULL,
  color         TEXT NOT NULL,
  invite_code   TEXT NOT NULL UNIQUE,
  version       TEXT NOT NULL,
  source_sha256 TEXT,
  video_url     TEXT,
  width         INTEGER,
  height        INTEGER,
  frame_count   INTEGER,
  head_version_id TEXT,          -- 현재 버전(HEAD). 비어 있으면 가장 최근 반영본
  head_set_by     TEXT,
  head_set_at     REAL,
  created_at    REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS collaborators (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     TEXT REFERENCES users(id),
  name        TEXT NOT NULL,
  role        TEXT NOT NULL,
  counts      TEXT NOT NULL,
  permission  TEXT NOT NULL,
  joined      INTEGER NOT NULL DEFAULT 0,
  created_at  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS versions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number        INTEGER,               -- main 위 순번. 반영되기 전에는 NULL
  parent_id     TEXT REFERENCES versions(id),
  title         TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  author_id     TEXT NOT NULL REFERENCES users(id),
  count_from    INTEGER,               -- (구버전) 카운트 기반 구간. 표시용으로만 남긴다
  count_to      INTEGER,
  start_ms      INTEGER,               -- 작품 타임라인 위의 구간 (밀리초)
  end_ms        INTEGER,
  duration_ms   INTEGER,               -- 이 버전에 붙은 영상의 길이
  source_sha256 TEXT,
  video_url     TEXT,
  width         INTEGER,
  height        INTEGER,
  frame_count   INTEGER,
  state         TEXT NOT NULL,         -- proposed | merged | declined
  created_at    REAL NOT NULL,
  decided_at    REAL,
  decided_by    TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS versions_project ON versions(project_id, state);
CREATE TABLE IF NOT EXISTS follows (
  follower_id  TEXT NOT NULL REFERENCES users(id),
  following_id TEXT NOT NULL REFERENCES users(id),
  created_at   REAL NOT NULL,
  PRIMARY KEY (follower_id, following_id)
);
CREATE INDEX IF NOT EXISTS collaborators_project ON collaborators(project_id);
CREATE INDEX IF NOT EXISTS collaborators_user ON collaborators(user_id);
-- 연습 기록은 versions 와 분리한다. 안무를 실제로 고친 것(수정 제안·반영)이 아니라
-- 개인 연습 결과일 뿐이라, 여기 섞이면 협업자에게 "누가 안무를 바꿨다"는 잘못된 인상을 준다.
CREATE TABLE IF NOT EXISTS practice_runs (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id               TEXT NOT NULL REFERENCES users(id),
  reference_version_id  TEXT REFERENCES versions(id),
  source_sha256         TEXT,
  video_url             TEXT,
  width                 INTEGER,
  height                INTEGER,
  frame_count           INTEGER,
  overall_score         REAL,
  mirrored              INTEGER NOT NULL DEFAULT 0,
  created_at            REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS practice_runs_project ON practice_runs(project_id, user_id);
"""


def connect() -> sqlite3.Connection:
    """스레드마다 연결을 따로 둔다 (sqlite3 연결은 스레드 간 공유 불가)."""
    existing = getattr(_local, "connection", None)
    if existing is not None:
        return existing
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")  # 읽기와 쓰기가 서로를 막지 않게
    _local.connection = connection
    return connection


def init() -> None:
    connect().executescript(SCHEMA)
    # 이미 만들어진 DB 에는 CREATE TABLE IF NOT EXISTS 가 열을 추가해 주지 않는다
    existing = {row["name"] for row in connect().execute("PRAGMA table_info(versions)")}
    for column in ("start_ms", "end_ms", "duration_ms"):
        if column not in existing:
            connect().execute(f"ALTER TABLE versions ADD COLUMN {column} INTEGER")
    have = {row["name"] for row in connect().execute("PRAGMA table_info(projects)")}
    for column, kind in (("head_version_id", "TEXT"), ("head_set_by", "TEXT"), ("head_set_at", "REAL")):
        if column not in have:
            connect().execute(f"ALTER TABLE projects ADD COLUMN {column} {kind}")
    connect().commit()


def fmt_ms(ms: int | float) -> str:
    """밀리초를 분:초 로. 구간 표기는 사람이 읽는 형식이 기본이다."""
    total = max(0, int(round(ms / 1000)))
    return f"{total // 60}:{total % 60:02d}"


def new_id() -> str:
    return uuid.uuid4().hex


def new_invite_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # 헷갈리는 0/O/1/I 는 뺀다
    return "-".join("".join(secrets.choice(alphabet) for _ in range(4)) for _ in range(2))


# ── 사용자 ──

def create_user(name: str) -> dict:
    user = {"id": new_id(), "name": name.strip() or "익명 안무가", "created_at": time.time()}
    connect().execute("INSERT INTO users (id, name, created_at) VALUES (:id, :name, :created_at)", user)
    connect().commit()
    return {"user_id": user["id"], "name": user["name"]}


def get_user(user_id: str) -> dict | None:
    row = connect().execute("SELECT id, name FROM users WHERE id = ?", (user_id,)).fetchone()
    return {"user_id": row["id"], "name": row["name"]} if row else None


def rename_user(user_id: str, name: str) -> dict | None:
    connect().execute("UPDATE users SET name = ? WHERE id = ?", (name.strip() or "익명 안무가", user_id))
    connect().commit()
    return get_user(user_id)


# ── 프로젝트 ──

def _project_row(row: sqlite3.Row, owner_name: str, collaborators: list[dict], viewer_id: str | None) -> dict:
    mine = row["owner_id"] == viewer_id
    permission = "직접 수정" if mine else next(
        (item["permission"] for item in collaborators if item["user_id"] == viewer_id), None)
    return {
        "id": row["id"], "name": row["name"], "version": row["version"], "license": row["license"],
        "color": row["color"], "inviteCode": row["invite_code"],
        "date": time.strftime("%Y-%m-%d", time.localtime(row["created_at"])),
        "ownerId": row["owner_id"], "ownerName": owner_name, "isOwner": mine,
        "viewerPermission": permission,
        "sourceSha256": row["source_sha256"], "videoUrl": row["video_url"],
        "videoWidth": row["width"], "videoHeight": row["height"], "poseFrames": row["frame_count"],
        "collaborators": collaborators,
        "workMs": work_ms(row["id"]),
    }


def _collaborators(project_id: str) -> list[dict]:
    rows = connect().execute(
        "SELECT id, user_id, name, role, counts, permission, joined FROM collaborators "
        "WHERE project_id = ? ORDER BY created_at", (project_id,)).fetchall()
    return [{"id": r["id"], "user_id": r["user_id"], "name": r["name"], "role": r["role"],
             "counts": r["counts"], "permission": r["permission"], "joined": bool(r["joined"])} for r in rows]


def create_project(owner_id: str, name: str, license_name: str, color: str, motion: dict | None) -> dict:
    motion = motion or {}
    project = {
        "id": new_id(), "name": name.strip() or "제목 없는 안무", "owner_id": owner_id,
        "license": license_name, "color": color, "invite_code": new_invite_code(),
        "version": "원작 · 새 영상", "source_sha256": motion.get("source_sha256"),
        "video_url": motion.get("video_url"), "width": motion.get("width"), "height": motion.get("height"),
        "frame_count": motion.get("frame_count"), "created_at": time.time(),
    }
    connect().execute(
        "INSERT INTO projects (id, name, owner_id, license, color, invite_code, version, source_sha256,"
        " video_url, width, height, frame_count, created_at) VALUES (:id, :name, :owner_id, :license,"
        " :color, :invite_code, :version, :source_sha256, :video_url, :width, :height, :frame_count, :created_at)",
        project)
    connect().commit()
    create_version(project["id"], owner_id, "원작 등록", "첫 버전으로 기록했습니다.",
                   None, None, motion, merged=True)
    return get_project(project["id"], owner_id)


def get_project(project_id: str, viewer_id: str | None = None) -> dict | None:
    row = connect().execute(
        "SELECT p.*, u.name AS owner_name FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.id = ?",
        (project_id,)).fetchone()
    if not row:
        return None
    return _project_row(row, row["owner_name"], _collaborators(project_id), viewer_id)


def list_projects(viewer_id: str) -> list[dict]:
    """내가 만든 작업 + 초대받아 참여한 작업."""
    rows = connect().execute(
        "SELECT DISTINCT p.*, u.name AS owner_name FROM projects p"
        " JOIN users u ON u.id = p.owner_id"
        " LEFT JOIN collaborators c ON c.project_id = p.id"
        " WHERE p.owner_id = ? OR c.user_id = ?"
        " ORDER BY p.created_at DESC", (viewer_id, viewer_id)).fetchall()
    return [_project_row(row, row["owner_name"], _collaborators(row["id"]), viewer_id) for row in rows]


def update_project(project_id: str, name: str | None = None, license_name: str | None = None) -> dict | None:
    if name is not None:
        connect().execute("UPDATE projects SET name = ? WHERE id = ?", (name.strip() or "제목 없는 안무", project_id))
    if license_name is not None:
        connect().execute("UPDATE projects SET license = ? WHERE id = ?", (license_name, project_id))
    connect().commit()
    return get_project(project_id)


def attach_motion(project_id: str, motion: dict) -> dict | None:
    connect().execute(
        "UPDATE projects SET source_sha256 = ?, video_url = ?, width = ?, height = ?, frame_count = ?"
        " WHERE id = ?",
        (motion.get("source_sha256"), motion.get("video_url"), motion.get("width"),
         motion.get("height"), motion.get("frame_count"), project_id))
    connect().commit()
    return get_project(project_id)


# ── 공동 작업자 ──

def can_edit(project_id: str, user_id: str | None) -> bool:
    """소유자이거나 '직접 수정' 권한으로 참여한 사람만 바꿀 수 있다."""
    if not user_id:
        return False
    row = connect().execute("SELECT owner_id FROM projects WHERE id = ?", (project_id,)).fetchone()
    if not row:
        return False
    if row["owner_id"] == user_id:
        return True
    found = connect().execute(
        "SELECT permission FROM collaborators WHERE project_id = ? AND user_id = ?",
        (project_id, user_id)).fetchone()
    return bool(found and found["permission"] == "직접 수정")


def add_collaborator(project_id: str, name: str, role: str, counts: str, permission: str,
                     user_id: str | None = None, joined: bool = False) -> dict:
    entry = {
        "id": new_id(), "project_id": project_id, "user_id": user_id,
        "name": name.strip(), "role": role.strip() or "함께 작업", "counts": counts.strip() or "구간 미정",
        "permission": permission if permission in PERMISSIONS else "수정 제안",
        "joined": 1 if joined else 0, "created_at": time.time(),
    }
    connect().execute(
        "INSERT INTO collaborators (id, project_id, user_id, name, role, counts, permission, joined, created_at)"
        " VALUES (:id, :project_id, :user_id, :name, :role, :counts, :permission, :joined, :created_at)", entry)
    connect().commit()
    return {k: entry[k] for k in ("id", "user_id", "name", "role", "counts", "permission")} | {"joined": joined}


def update_collaborator(collab_id: str, name: str, role: str, counts: str, permission: str) -> None:
    connect().execute(
        "UPDATE collaborators SET name = ?, role = ?, counts = ?, permission = ? WHERE id = ?",
        (name.strip(), role.strip() or "함께 작업", counts.strip() or "구간 미정",
         permission if permission in PERMISSIONS else "수정 제안", collab_id))
    connect().commit()


def remove_collaborator(collab_id: str) -> None:
    connect().execute("DELETE FROM collaborators WHERE id = ?", (collab_id,))
    connect().commit()


def project_by_code(code: str) -> dict | None:
    row = connect().execute("SELECT id FROM projects WHERE invite_code = ?", (code.strip().upper(),)).fetchone()
    return get_project(row["id"]) if row else None


def join_by_code(code: str, user_id: str) -> dict | None:
    """초대 코드로 참여한다. 이미 참여 중이면 그대로 둔다.

    초대장에 미리 적어 둔 자리(user_id 가 비어 있고 이름이 같은 행)가 있으면 그 자리에
    사용자를 연결한다. 없으면 새로 추가한다 — 링크를 받은 사람이 바로 들어올 수 있게.
    """
    project = project_by_code(code)
    if not project:
        return None
    user = get_user(user_id)
    if not user:
        return None
    if project["ownerId"] == user_id:
        return get_project(project["id"], user_id)

    existing = connect().execute(
        "SELECT id FROM collaborators WHERE project_id = ? AND user_id = ?", (project["id"], user_id)).fetchone()
    if existing:
        return get_project(project["id"], user_id)

    reserved = connect().execute(
        "SELECT id FROM collaborators WHERE project_id = ? AND user_id IS NULL AND name = ?",
        (project["id"], user["name"])).fetchone()
    if reserved:
        connect().execute("UPDATE collaborators SET user_id = ?, joined = 1 WHERE id = ?", (user_id, reserved["id"]))
        connect().commit()
    else:
        add_collaborator(project["id"], user["name"], "초대로 참여", "구간 미정", "수정 제안",
                         user_id=user_id, joined=True)
    return get_project(project["id"], user_id)


# 공유 범위가 '연습 전용' 인 작업은 본인에게만 보인다. 앱이 내세우는 공유 범위의 의미를
# 커뮤니티 화면에서도 지키기 위한 것이다.
PRIVATE_LICENSE = "연습 전용"


def follow(follower_id: str, following_id: str) -> None:
    if follower_id == following_id:
        return
    connect().execute(
        "INSERT OR IGNORE INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)",
        (follower_id, following_id, time.time()))
    connect().commit()


def unfollow(follower_id: str, following_id: str) -> None:
    connect().execute("DELETE FROM follows WHERE follower_id = ? AND following_id = ?",
                      (follower_id, following_id))
    connect().commit()


def follow_state(user_id: str, viewer_id: str | None) -> dict:
    followers = connect().execute("SELECT COUNT(*) AS n FROM follows WHERE following_id = ?", (user_id,)).fetchone()["n"]
    following = connect().execute("SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?", (user_id,)).fetchone()["n"]
    mine = bool(viewer_id and viewer_id != user_id and connect().execute(
        "SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?", (viewer_id, user_id)).fetchone())
    return {"followers": followers, "following": following, "isFollowing": mine}


def community(viewer_id: str | None, limit: int = 30) -> dict:
    """탐색 화면 — 사람 목록과 공개 작업 피드."""
    people = []
    rows = connect().execute(
        "SELECT u.id, u.name, u.created_at,"
        " (SELECT COUNT(*) FROM projects p WHERE p.owner_id = u.id AND p.license != ?) AS works"
        " FROM users u ORDER BY u.created_at DESC LIMIT ?", (PRIVATE_LICENSE, limit)).fetchall()
    for row in rows:
        state = follow_state(row["id"], viewer_id)
        people.append({"user_id": row["id"], "name": row["name"], "handle": row["id"][:7],
                       "works": row["works"], "isMe": row["id"] == viewer_id, **state})

    feed_rows = connect().execute(
        "SELECT p.id, p.name, p.color, p.license, p.version, p.created_at, p.frame_count,"
        " u.id AS owner_id, u.name AS owner_name,"
        " (SELECT COUNT(*) FROM collaborators c WHERE c.project_id = p.id) AS people"
        " FROM projects p JOIN users u ON u.id = p.owner_id"
        " WHERE p.license != ? ORDER BY p.created_at DESC LIMIT ?", (PRIVATE_LICENSE, limit)).fetchall()
    feed = [{"id": r["id"], "name": r["name"], "color": r["color"], "license": r["license"],
             "version": r["version"], "ownerId": r["owner_id"], "ownerName": r["owner_name"],
             "people": r["people"], "poseFrames": r["frame_count"],
             "date": time.strftime("%Y-%m-%d", time.localtime(r["created_at"]))} for r in feed_rows]
    return {"people": people, "feed": feed}


# ── 버전 (main 브랜치) ──
#
# GitHub 의 main 브랜치를 그대로 옮겼다. 원작이 1번 버전이고, 참여자는 "어느 구간을
# 어떻게 고쳤다"를 제안(proposed)한다. 원작자나 '직접 수정' 권한자가 반영(merged)하면
# main 위에 다음 번호로 쌓인다. 거절하면 declined 로 남는다 — 지워지지 않는다.
#
# 기록의 표준이 목표이므로 구간은 자유 텍스트가 아니라 카운트 숫자(count_from/to)다.

def _version_row(row: sqlite3.Row, author_name: str, decider_name: str | None) -> dict:
    return {
        "id": row["id"], "number": row["number"], "parentId": row["parent_id"],
        "title": row["title"], "note": row["note"],
        "authorId": row["author_id"], "authorName": author_name,
        "startMs": row["start_ms"], "endMs": row["end_ms"], "durationMs": row["duration_ms"],
        "segment": (f"{fmt_ms(row['start_ms'])}–{fmt_ms(row['end_ms'])}"
                    if row["start_ms"] is not None and row["end_ms"] is not None else "전체"),
        "sourceSha256": row["source_sha256"], "videoUrl": row["video_url"],
        "videoWidth": row["width"], "videoHeight": row["height"], "poseFrames": row["frame_count"],
        "state": row["state"],
        "date": time.strftime("%Y-%m-%d", time.localtime(row["created_at"])),
        "decidedAt": (time.strftime("%Y-%m-%d", time.localtime(row["decided_at"])) if row["decided_at"] else None),
        "decidedByName": decider_name,
    }


def _name_of(user_id: str | None) -> str | None:
    if not user_id:
        return None
    row = connect().execute("SELECT name FROM users WHERE id = ?", (user_id,)).fetchone()
    return row["name"] if row else None


def list_versions(project_id: str) -> dict:
    rows = connect().execute(
        "SELECT * FROM versions WHERE project_id = ? ORDER BY COALESCE(number, 9999), created_at",
        (project_id,)).fetchall()
    items = [_version_row(row, _name_of(row["author_id"]) or "알 수 없음", _name_of(row["decided_by"])) for row in rows]
    head = main_head(project_id)
    row = connect().execute(
        "SELECT head_version_id, head_set_by, head_set_at FROM projects WHERE id = ?", (project_id,)).fetchone()
    pinned = bool(row and row["head_version_id"])
    return {
        "main": [item for item in items if item["state"] == "merged"],
        "proposed": [item for item in items if item["state"] == "proposed"],
        "declined": [item for item in items if item["state"] == "declined"],
        "headId": head["id"] if head else None,
        "headPinned": pinned,
        "headSetByName": _name_of(row["head_set_by"]) if pinned else None,
        "headSetAt": (time.strftime("%Y-%m-%d", time.localtime(row["head_set_at"]))
                      if pinned and row["head_set_at"] else None),
    }


def main_head(project_id: str) -> dict | None:
    """현재 버전. 사용자가 지정한 HEAD 가 있으면 그것, 없으면 가장 최근 반영본.

    지정을 허용해도 이력은 지우지 않는다 — 되돌린다는 사실 자체가 기록의 일부다.
    """
    pointer = connect().execute(
        "SELECT head_version_id FROM projects WHERE id = ?", (project_id,)).fetchone()
    if pointer and pointer["head_version_id"]:
        row = connect().execute(
            "SELECT * FROM versions WHERE id = ? AND project_id = ? AND state = 'merged'",
            (pointer["head_version_id"], project_id)).fetchone()
        if row:
            return _version_row(row, _name_of(row["author_id"]) or "알 수 없음", _name_of(row["decided_by"]))
    row = connect().execute(
        "SELECT * FROM versions WHERE project_id = ? AND state = 'merged' ORDER BY number DESC LIMIT 1",
        (project_id,)).fetchone()
    return _version_row(row, _name_of(row["author_id"]) or "알 수 없음", _name_of(row["decided_by"])) if row else None


def set_head(project_id: str, version_id: str, user_id: str) -> None:
    """현재 버전을 지정한다. 반영된 버전만 고를 수 있다."""
    row = connect().execute(
        "SELECT id FROM versions WHERE id = ? AND project_id = ? AND state = 'merged'",
        (version_id, project_id)).fetchone()
    if not row:
        raise ValueError("반영된 버전만 현재 버전으로 지정할 수 있습니다.")
    connect().execute(
        "UPDATE projects SET head_version_id = ?, head_set_by = ?, head_set_at = ? WHERE id = ?",
        (version_id, user_id, time.time(), project_id))
    connect().commit()
    _sync_project_head(project_id)


def work_ms(project_id: str) -> int:
    """작품 타임라인의 길이.

    v1 의 영상 길이로 시작하지만 **반영된 구간이 그보다 뒤까지 가면 작품이 길어진다.**
    안무는 늘어날 수 있고, 늘어났다는 사실도 기록할 값어치가 있다.
    제안 상태(proposed)는 포함하지 않는다 — 반영돼야 작품 길이가 바뀐다.
    """
    row = connect().execute(
        "SELECT duration_ms FROM versions WHERE project_id = ? AND number = 1", (project_id,)).fetchone()
    base = int(row["duration_ms"] or 0) if row else 0
    if not base:
        row = connect().execute(
            "SELECT MAX(duration_ms) AS d FROM versions WHERE project_id = ? AND state = 'merged'",
            (project_id,)).fetchone()
        base = int(row["d"] or 0)
    row = connect().execute(
        "SELECT MAX(end_ms) AS e FROM versions WHERE project_id = ? AND state = 'merged'",
        (project_id,)).fetchone()
    return max(base, int(row["e"] or 0))


def _practice_run_row(row: sqlite3.Row, user_name: str | None) -> dict:
    return {
        "id": row["id"], "projectId": row["project_id"], "userId": row["user_id"],
        "userName": user_name, "referenceVersionId": row["reference_version_id"],
        "sourceSha256": row["source_sha256"], "videoUrl": row["video_url"],
        "videoWidth": row["width"], "videoHeight": row["height"], "frameCount": row["frame_count"],
        "overallScore": row["overall_score"], "mirrored": bool(row["mirrored"]),
        "createdAt": time.strftime("%Y-%m-%d %H:%M", time.localtime(row["created_at"])),
    }


def create_practice_run(project_id: str, user_id: str, reference_version_id: str | None,
                        motion: dict, overall_score: float | None, mirrored: bool) -> dict:
    """연습 결과를 남긴다. versions 와 완전히 분리된 테이블이라 버전 이력·HEAD·크레딧에 전혀
    영향을 주지 않는다 — 이건 안무를 고친 게 아니라 그냥 연습한 것이다."""
    entry = {
        "id": new_id(), "project_id": project_id, "user_id": user_id,
        "reference_version_id": reference_version_id,
        "source_sha256": motion.get("source_sha256"), "video_url": motion.get("video_url"),
        "width": motion.get("width"), "height": motion.get("height"),
        "frame_count": motion.get("frame_count"),
        "overall_score": overall_score, "mirrored": 1 if mirrored else 0,
        "created_at": time.time(),
    }
    connect().execute(
        "INSERT INTO practice_runs (id, project_id, user_id, reference_version_id, source_sha256,"
        " video_url, width, height, frame_count, overall_score, mirrored, created_at) VALUES"
        " (:id, :project_id, :user_id, :reference_version_id, :source_sha256, :video_url, :width,"
        " :height, :frame_count, :overall_score, :mirrored, :created_at)", entry)
    connect().commit()
    row = connect().execute("SELECT * FROM practice_runs WHERE id = ?", (entry["id"],)).fetchone()
    return _practice_run_row(row, _name_of(user_id))


def list_practice_runs(project_id: str, user_id: str | None = None) -> list[dict]:
    query = "SELECT * FROM practice_runs WHERE project_id = ?"
    params: list = [project_id]
    if user_id:
        query += " AND user_id = ?"
        params.append(user_id)
    query += " ORDER BY created_at DESC LIMIT 30"
    rows = connect().execute(query, params).fetchall()
    return [_practice_run_row(row, _name_of(row["user_id"])) for row in rows]


def create_version(project_id: str, author_id: str, title: str, note: str,
                   start_ms: int | None, end_ms: int | None,
                   motion: dict | None, merged: bool) -> dict:
    """제안을 만든다. `merged=True` 면 곧바로 main 에 올린다 (원작 등록·권한자 직접 수정)."""
    motion = motion or {}
    head = main_head(project_id)
    number = None
    if merged:
        top = connect().execute(
            "SELECT COALESCE(MAX(number), 0) AS n FROM versions WHERE project_id = ? AND state = 'merged'",
            (project_id,)).fetchone()["n"]
        number = top + 1
    now = time.time()
    entry = {
        "id": new_id(), "project_id": project_id, "number": number,
        "parent_id": head["id"] if head else None,
        "title": title.strip() or "수정 제안", "note": note.strip(),
        "author_id": author_id, "count_from": None, "count_to": None,
        "start_ms": start_ms, "end_ms": end_ms, "duration_ms": motion.get("duration_ms"),
        "source_sha256": motion.get("source_sha256"), "video_url": motion.get("video_url"),
        "width": motion.get("width"), "height": motion.get("height"),
        "frame_count": motion.get("frame_count"),
        "state": "merged" if merged else "proposed",
        "created_at": now, "decided_at": now if merged else None,
        "decided_by": author_id if merged else None,
    }
    connect().execute(
        "INSERT INTO versions (id, project_id, number, parent_id, title, note, author_id, count_from,"
        " count_to, start_ms, end_ms, duration_ms, source_sha256, video_url, width, height, frame_count,"
        " state, created_at, decided_at, decided_by) VALUES (:id, :project_id, :number, :parent_id, :title,"
        " :note, :author_id, :count_from, :count_to, :start_ms, :end_ms, :duration_ms, :source_sha256,"
        " :video_url, :width, :height, :frame_count, :state, :created_at, :decided_at, :decided_by)", entry)
    connect().commit()
    if merged:
        clear_head_pin(project_id)
        _sync_project_head(project_id)
    return list_versions(project_id)


def decide_version(project_id: str, version_id: str, decider_id: str, accept: bool) -> dict:
    """반영하거나 거절한다. 반영하면 main 의 다음 번호를 받고 직전 head 를 부모로 삼는다."""
    row = connect().execute(
        "SELECT state FROM versions WHERE id = ? AND project_id = ?", (version_id, project_id)).fetchone()
    if not row or row["state"] != "proposed":
        raise ValueError("이미 처리된 제안입니다.")
    if accept:
        head = main_head(project_id)
        top = connect().execute(
            "SELECT COALESCE(MAX(number), 0) AS n FROM versions WHERE project_id = ? AND state = 'merged'",
            (project_id,)).fetchone()["n"]
        connect().execute(
            "UPDATE versions SET state = 'merged', number = ?, parent_id = ?, decided_at = ?, decided_by = ?"
            " WHERE id = ?", (top + 1, head["id"] if head else None, time.time(), decider_id, version_id))
    else:
        connect().execute(
            "UPDATE versions SET state = 'declined', decided_at = ?, decided_by = ? WHERE id = ?",
            (time.time(), decider_id, version_id))
    connect().commit()
    if accept:
        clear_head_pin(project_id)
        _sync_project_head(project_id)
    return list_versions(project_id)


def clear_head_pin(project_id: str) -> None:
    """새 버전이 반영되면 그것이 현재가 되어야 한다 — 되돌려 둔 지정을 푼다.

    이게 없으면 되돌린 상태에서 반영해도 화면이 그대로여서 아무 일도 없어 보인다.
    """
    connect().execute(
        "UPDATE projects SET head_version_id = NULL, head_set_by = NULL, head_set_at = NULL WHERE id = ?",
        (project_id,))
    connect().commit()


def _sync_project_head(project_id: str) -> None:
    """작업 카드가 항상 main 의 최신 상태를 가리키게 한다.

    영상이 붙은 버전이 반영되면 그 영상이 작업의 현재 영상이 된다. 영상 없는 메모형
    버전이면 기존 영상을 유지한다.
    """
    head = main_head(project_id)
    if not head:
        return
    pinned = connect().execute(
        "SELECT head_version_id FROM projects WHERE id = ?", (project_id,)).fetchone()
    top = connect().execute(
        "SELECT MAX(number) AS n FROM versions WHERE project_id = ? AND state = 'merged'",
        (project_id,)).fetchone()["n"]
    behind = pinned and pinned["head_version_id"] and top and head["number"] < top
    label = f"main · v{head['number']} · {head['segment']}" + (" · 되돌림" if behind else "")
    connect().execute("UPDATE projects SET version = ? WHERE id = ?", (label, project_id))
    # 작품의 정본 영상은 **전체를 다루는 버전**만 교체한다.
    # 구간 수정(예: 0:02–0:05)이 작품 원본을 덮으면 3초 클립이 작품 전체가 되어 버린다.
    # 구간별 클립은 그 버전에 붙어 있고, '구간 영상 보기' 로 따로 재생한다.
    covers_all = head.get("startMs") is None or (
        head.get("startMs") == 0 and (head.get("endMs") or 0) >= work_ms(project_id))
    if head.get("sourceSha256") and covers_all:
        connect().execute(
            "UPDATE projects SET source_sha256 = ?, video_url = ?, width = ?, height = ?, frame_count = ?"
            " WHERE id = ?",
            (head["sourceSha256"], head["videoUrl"], head["videoWidth"], head["videoHeight"],
             head["poseFrames"], project_id))
    connect().commit()


def is_owner(project_id: str, user_id: str | None) -> bool:
    if not user_id:
        return False
    row = connect().execute("SELECT owner_id FROM projects WHERE id = ?", (project_id,)).fetchone()
    return bool(row and row["owner_id"] == user_id)


def delete_project(project_id: str) -> dict:
    """작업을 지운다. 버전·참여자는 ON DELETE CASCADE 로 함께 사라진다.

    **업로드 파일은 지우지 않는다.** 파일 이름이 내용 해시라 같은 영상을 올린 다른 작업이
    같은 파일을 가리킬 수 있다. 지우면 남의 작업이 깨진다. 파일 정리는 참조 카운트를
    세는 별도 작업으로 다뤄야 한다.
    """
    counts = {
        "versions": connect().execute(
            "SELECT COUNT(*) AS n FROM versions WHERE project_id = ?", (project_id,)).fetchone()["n"],
        "collaborators": connect().execute(
            "SELECT COUNT(*) AS n FROM collaborators WHERE project_id = ?", (project_id,)).fetchone()["n"],
    }
    connect().execute("DELETE FROM projects WHERE id = ?", (project_id,))
    connect().commit()
    return counts


def can_propose(project_id: str, user_id: str | None) -> bool:
    """'보기만' 을 제외한 참여자와 원작자가 제안할 수 있다."""
    if not user_id:
        return False
    row = connect().execute("SELECT owner_id FROM projects WHERE id = ?", (project_id,)).fetchone()
    if not row:
        return False
    if row["owner_id"] == user_id:
        return True
    found = connect().execute(
        "SELECT permission FROM collaborators WHERE project_id = ? AND user_id = ?",
        (project_id, user_id)).fetchone()
    return bool(found and found["permission"] in ("수정 제안", "직접 수정"))


def profile(user_id: str, viewer_id: str | None = None) -> dict | None:
    """GitHub 프로필처럼 활동을 요약한다 — 통계 · 기여 달력 · 최근 활동.

    기여로 세는 것: 내가 만든 작업, 내 작업에 누군가를 초대한 일, 내가 초대받아 참여한 일.
    모두 행의 `created_at` 을 그대로 쓴다.
    """
    user = get_user(user_id)
    if not user:
        return None

    is_me = viewer_id == user_id
    owned = connect().execute(
        "SELECT id, name, color, license, version, created_at FROM projects WHERE owner_id = ?"
        + ("" if is_me else " AND license != ?") + " ORDER BY created_at DESC",
        (user_id,) if is_me else (user_id, PRIVATE_LICENSE)).fetchall()
    joined = connect().execute(
        "SELECT p.id, p.name, p.color, p.license, u.name AS owner_name, c.permission, c.created_at"
        " FROM collaborators c JOIN projects p ON p.id = c.project_id JOIN users u ON u.id = p.owner_id"
        " WHERE c.user_id = ? AND p.owner_id != ? ORDER BY c.created_at DESC", (user_id, user_id)).fetchall()
    invited = connect().execute(
        "SELECT c.name, c.created_at, p.name AS project_name FROM collaborators c"
        " JOIN projects p ON p.id = c.project_id"
        " WHERE p.owner_id = ? AND (c.user_id IS NULL OR c.user_id != ?) ORDER BY c.created_at DESC",
        (user_id, user_id)).fetchall()

    events: list[tuple[float, str, str]] = []
    for row in owned:
        events.append((row["created_at"], "project", f"‘{row['name']}’ 작업을 시작했어요"))
    for row in invited:
        events.append((row["created_at"], "invite", f"‘{row['project_name']}’ 에 {row['name']}님을 초대했어요"))
    for row in joined:
        events.append((row["created_at"], "join", f"{row['owner_name']}님의 ‘{row['name']}’ 에 참여했어요"))

    # 기여 달력: 오늘이 속한 주까지 53주. 일요일 시작 (GitHub 과 같은 배치)
    counts: dict[str, int] = {}
    for stamp, _, _ in events:
        day = time.strftime("%Y-%m-%d", time.localtime(stamp))
        counts[day] = counts.get(day, 0) + 1

    today = time.localtime()
    midnight = time.mktime((today.tm_year, today.tm_mon, today.tm_mday, 0, 0, 0, 0, 0, -1))
    weekday = (today.tm_wday + 1) % 7  # 월=0 → 일=0 으로
    last_sunday = midnight - weekday * 86400
    start = last_sunday - 52 * 7 * 86400

    weeks, months, previous_month = [], [], None
    for week_index in range(53):
        days = []
        for day_index in range(7):
            stamp = start + (week_index * 7 + day_index) * 86400
            label = time.strftime("%Y-%m-%d", time.localtime(stamp))
            days.append({"d": label, "c": counts.get(label, 0) if stamp <= midnight else -1})
        weeks.append(days)
        month = time.localtime(start + week_index * 7 * 86400).tm_mon
        if month != previous_month:
            months.append({"label": f"{month}월", "week": week_index})
            previous_month = month

    people = connect().execute(
        "SELECT COUNT(DISTINCT c.name) AS total FROM collaborators c JOIN projects p ON p.id = c.project_id"
        " WHERE p.owner_id = ?", (user_id,)).fetchone()["total"]
    frames = connect().execute(
        "SELECT COALESCE(SUM(frame_count), 0) AS total FROM projects WHERE owner_id = ?",
        (user_id,)).fetchone()["total"]
    first = connect().execute("SELECT created_at FROM users WHERE id = ?", (user_id,)).fetchone()["created_at"]

    events.sort(key=lambda item: item[0], reverse=True)
    return {
        "user_id": user_id, "name": user["name"],
        "handle": user_id[:7], "isMe": is_me, **follow_state(user_id, viewer_id),
        "joinedAt": time.strftime("%Y년 %m월", time.localtime(first)),
        "stats": {"owned": len(owned), "joined": len(joined), "people": people, "frames": frames},
        "contributions": {"weeks": weeks, "months": months, "total": sum(counts.values())},
        "projects": [{"id": r["id"], "name": r["name"], "color": r["color"], "license": r["license"],
                      "version": r["version"], "isOwner": True} for r in owned[:4]]
                    + [{"id": r["id"], "name": r["name"], "color": r["color"], "license": r["license"],
                        "version": f"{r['owner_name']}님의 작업", "isOwner": False} for r in joined[:2]],
        "activity": [{"kind": kind, "text": text,
                      "date": time.strftime("%Y-%m-%d", time.localtime(stamp))} for stamp, kind, text in events[:10]],
    }


def seed_demo(owner_id: str) -> None:
    """첫 사용자에게만 예시 작업을 준다. 실제 행이라 수정·초대가 그대로 동작한다.

    사용자마다 심으면 이름이 같은 작업이 여럿 생겨 협업 화면에서 헷갈린다. 두 번째
    사용자부터는 빈 상태로 시작해 초대 코드로 들어오는 게 실제 흐름과도 맞다.
    """
    if connect().execute("SELECT 1 FROM projects").fetchone():
        return
    samples = [
        ("Tide marks", "원작 · 16 count", "비상업 커버 허용", "#2454E6",
         [("BADA", "안무 구성", "count 09–16", "직접 수정"), ("YUJIN", "포메이션", "count 13–16", "수정 제안")]),
        ("Blue hour", "파생 · 08 count", "리믹스 허용", "#E94F37", []),
    ]
    for name, version, license_name, color, people in samples:
        project = create_project(owner_id, name, license_name, color, None)
        connect().execute("UPDATE projects SET version = ? WHERE id = ?", (version, project["id"]))
        for person, role, counts, permission in people:
            add_collaborator(project["id"], person, role, counts, permission)
    connect().commit()
