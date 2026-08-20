"""ChoreoHub's server-side MediaPipe choreography extractor."""

from __future__ import annotations

import csv
import hashlib
import json
import mimetypes
import multiprocessing
import os
import re
import shutil
import subprocess
import threading
import time
import traceback
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from fastapi import Body, Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from google import genai
from google.genai import types as genai_types
from mediapipe.tasks import python
from mediapipe.tasks.python import vision

import store

LANDMARK_NAMES = ["nose", "left_eye_inner", "left_eye", "left_eye_outer", "right_eye_inner", "right_eye", "right_eye_outer", "left_ear", "right_ear", "mouth_left", "mouth_right", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist", "left_pinky", "right_pinky", "left_index", "right_index", "left_thumb", "right_thumb", "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle", "left_heel", "right_heel", "left_foot_index", "right_foot_index"]
CONNECTIONS = [(11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (11, 23), (12, 24), (23, 24), (23, 25), (25, 27), (24, 26), (26, 28), (27, 29), (27, 31), (29, 31), (28, 30), (28, 32), (30, 32), (0, 1), (1, 2), (2, 3), (0, 4), (4, 5), (5, 6), (9, 10)]
ROOT = Path(__file__).parent
MODEL_PATH = ROOT / "models" / "pose_landmarker_heavy.task"
UPLOADS_PATH = ROOT / "uploads"
UPLOADS_PATH.mkdir(exist_ok=True)

# 추론을 몇 개 프로세스로 나눌지. MediaPipe 는 코어 하나만 쓰므로 나누면 거의 선형으로
# 빨라진다. 워커마다 모델을 따로 적재하니 메모리도 비례해 늘어난다 (heavy 기준 워커당
# 300~500MB) — 메모리가 적은 서버에서는 POSE_WORKERS 를 낮춘다.
POSE_WORKERS = max(1, int(os.getenv("POSE_WORKERS", "4")))
# 청크 첫 프레임 앞에서 미리 흘려 보내고 버릴 프레임 수. RunningMode.VIDEO 는 프레임 간
# 추적을 이어 가므로 경계에서 추적이 리셋된다. 다만 실측으로는 효과가 미미했다
# (warmup 0 → x,y 평균 2.10px, 24 → 1.87px, 1초 추가). 경계 보험 정도로만 둔다.
CHUNK_WARMUP = max(0, int(os.getenv("POSE_CHUNK_WARMUP", "8")))

app = FastAPI(title="ChoreoHub MediaPipe service")
app.mount("/uploads", StaticFiles(directory=UPLOADS_PATH), name="uploads")
app.add_middleware(CORSMiddleware, allow_origins=os.getenv("CORS_ORIGINS", "*").split(","), allow_methods=["*"], allow_headers=["*"], expose_headers=["Content-Disposition"])
store.init()


def draw_overlay(frame: np.ndarray, points: list[list[float]] | None, index: int, time_s: float) -> np.ndarray:
    canvas = frame.copy()
    if points:
        height, width = canvas.shape[:2]
        for start, end in CONNECTIONS:
            cv2.line(canvas, (round(points[start][0] * width), round(points[start][1] * height)), (round(points[end][0] * width), round(points[end][1] * height)), (0, 230, 55), 4, cv2.LINE_AA)
        for point in points:
            cv2.circle(canvas, (round(point[0] * width), round(point[1] * height)), 5, (255, 100, 0), -1, cv2.LINE_AA)
    cv2.putText(canvas, f"f{index} t={time_s:.2f}s {'OK' if points else 'NO POSE'}", (22, 48), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (255, 255, 255), 3, cv2.LINE_AA)
    return canvas


def draw_skeleton(world: list[list[float]] | None, index: int, time_s: float) -> np.ndarray:
    canvas = np.full((450, 1200, 3), 250, dtype=np.uint8)
    cv2.putText(canvas, f"frame {index}    t={time_s:.2f}s", (510, 26), cv2.FONT_HERSHEY_SIMPLEX, .55, (30, 30, 30), 1, cv2.LINE_AA)
    panels = [(150, "Front (X-Y)", 0, 1), (480, "Side (Z-Y)", 2, 1), (810, "Top (X-Z)", 0, 2)]
    for left, title, first, second in panels:
        cv2.rectangle(canvas, (left, 90), (left + 275, 365), (40, 40, 40), 1); cv2.putText(canvas, title, (left + 74, 82), cv2.FONT_HERSHEY_SIMPLEX, .55, (30, 30, 30), 1, cv2.LINE_AA)
        if not world:
            continue
        def point_xy(point: list[float]) -> tuple[int, int]: return (round(left + 138 + point[first] * 230), round(228 + point[second] * 230))
        for start, end in CONNECTIONS: cv2.line(canvas, point_xy(world[start]), point_xy(world[end]), (36, 137, 180), 2, cv2.LINE_AA)
        for point in world: cv2.circle(canvas, point_xy(point), 4, (61, 92, 220), -1, cv2.LINE_AA)
    return canvas


def to_web_h264(path: Path) -> bool:
    """OpenCV 의 mp4v(MPEG-4 Part 2) 는 브라우저가 디코딩하지 못한다.

    Chrome 에서 `DEMUXER_ERROR_NO_SUPPORTED_STREAMS` 로 재생이 실패하므로
    ffmpeg 으로 H.264 로 다시 인코딩한다. ffmpeg 이 없으면 원본을 그대로 둔다.
    """
    if not path.exists() or not shutil.which("ffmpeg"):
        return False
    encoded = path.with_name(path.name.replace(".mp4", ".h264.mp4"))
    done = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(path),
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
         "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", str(encoded)],
        capture_output=True)
    if done.returncode == 0 and encoded.exists() and encoded.stat().st_size:
        encoded.replace(path)
        return True
    encoded.unlink(missing_ok=True)
    return False


def artifacts(base: str, payload: dict, overlay_path: Path, skeleton_path: Path) -> dict[str, str]:
    json_path, csv_path = UPLOADS_PATH / f"{base}.motion_3d.json", UPLOADS_PATH / f"{base}.motion_3d.csv"
    world_path, image_path, visibility_path = UPLOADS_PATH / f"{base}.pose_world_3d.npy", UPLOADS_PATH / f"{base}.pose_image_3d.npy", UPLOADS_PATH / f"{base}.visibility.npy"
    json_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    world_values, image_values, visibility_values, rows = [], [], [], []
    for frame in payload["frames"]:
        world, image, visibility = frame.get("world") or [[np.nan] * 3] * 33, frame.get("image") or [[np.nan] * 3] * 33, frame.get("visibility") or [0.0] * 33
        world_values.append(world); image_values.append(image); visibility_values.append(visibility)
        for landmark_id, landmark in enumerate(LANDMARK_NAMES): rows.append([frame["frame"], frame["time_s"], landmark_id, landmark, *world[landmark_id], *image[landmark_id], visibility[landmark_id]])
    np.save(world_path, np.asarray(world_values, dtype=np.float32)); np.save(image_path, np.asarray(image_values, dtype=np.float32)); np.save(visibility_path, np.asarray(visibility_values, dtype=np.float32))
    with csv_path.open("w", newline="", encoding="utf-8") as output:
        writer = csv.writer(output); writer.writerow(["frame", "time_s", "landmark_id", "landmark", "world_x", "world_y", "world_z", "img_x", "img_y", "img_z", "visibility"]); writer.writerows(rows)
    return {"motion_json_url": f"/uploads/{json_path.name}", "motion_csv_url": f"/uploads/{csv_path.name}", "pose_world_url": f"/uploads/{world_path.name}", "pose_image_url": f"/uploads/{image_path.name}", "visibility_url": f"/uploads/{visibility_path.name}", "preview_overlay_url": f"/uploads/{overlay_path.name}", "preview_3d_skeleton_url": f"/uploads/{skeleton_path.name}"}


@app.get("/health")
def health() -> dict: return {"status": "ok", "model": MODEL_PATH.stem, "workers": POSE_WORKERS}


# 진행 중인 분석 작업. 프로세스 메모리에만 있으므로 서버를 재시작하면 사라진다 —
# 산출물 자체는 uploads/ 에 남으니 데모 범위에서는 충분하다.
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()


def set_job(job_id: str, **fields) -> None:
    with JOBS_LOCK:
        JOBS.setdefault(job_id, {}).update(fields)


def get_job(job_id: str) -> dict | None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        return dict(job) if job else None


def store_upload(raw: bytes, filename: str | None) -> tuple[str, Path]:
    """업로드 본문을 해시 이름으로 저장하고 (해시, 경로) 를 돌려준다."""
    source_hash = hashlib.sha256(raw).hexdigest()
    suffix = Path(filename or "motion.mp4").suffix.lower() or ".mp4"
    video_path = UPLOADS_PATH / f"{source_hash}{suffix}"
    if not video_path.exists():
        video_path.write_bytes(raw)
    return source_hash, video_path


def probe(video_path: Path) -> dict:
    """분석을 기다리지 않고 앱이 먼저 영상을 띄울 수 있도록 메타데이터만 읽는다."""
    capture = cv2.VideoCapture(str(video_path))
    try:
        return {
            "fps": capture.get(cv2.CAP_PROP_FPS) or 30.0,
            "width": int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)),
            "height": int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)),
            "frame_count": int(capture.get(cv2.CAP_PROP_FRAME_COUNT)),
        }
    finally:
        capture.release()


def infer_range(model_path: str, video: str, start: int, count: int, warmup: int, fps: float, updates=None) -> list:
    """[start, start+count) 구간의 랜드마크를 뽑는다. 워커 프로세스에서 실행된다.

    `warmup` 프레임을 앞에서 미리 흘려 보낸 뒤 버린다. `RunningMode.VIDEO` 는 프레임 간
    추적을 이어 가므로, 청크 첫 프레임부터 바로 시작하면 경계에서 추적이 리셋되어 그
    부근 몇 프레임의 품질이 떨어진다.
    """
    capture = cv2.VideoCapture(video)
    begin = max(0, start - warmup)
    capture.set(cv2.CAP_PROP_POS_FRAMES, begin)
    options = vision.PoseLandmarkerOptions(base_options=python.BaseOptions(model_asset_path=model_path), running_mode=vision.RunningMode.VIDEO, num_poses=1, min_pose_detection_confidence=0.5, min_tracking_confidence=0.5)
    found, index, since_report, last_ts = [], begin, 0, -1
    try:
        with vision.PoseLandmarker.create_from_options(options) as pose:
            while index < start + count:
                ok, frame = capture.read()
                if not ok: break
                # 컨테이너가 실제로 기록한 프레임 시각(CAP_PROP_POS_MSEC)을 쓴다. `index / fps`로
                # 계산하면 fps 가 59.94 같은 값을 정수로 근사해 읽히는 경우 프레임마다 오차가
                # 조금씩 쌓여, 영상이 길어질수록 재생 화면의 실제 위치보다 계속 뒤로 밀린다
                # (스켈레톤이 몸동작을 한 박자 늦게 따라가는 것처럼 보이는 원인이었다).
                # 백엔드가 POS_MSEC 을 못 주거나 거꾸로 흐르는 경우에만 추정치로 대체한다 —
                # detect_for_video 는 타임스탬프가 반드시 증가해야 한다.
                timestamp_ms = round(capture.get(cv2.CAP_PROP_POS_MSEC))
                if timestamp_ms <= last_ts: timestamp_ms = round(index / fps * 1000)
                if timestamp_ms <= last_ts: timestamp_ms = last_ts + 1
                last_ts = timestamp_ms
                result = pose.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)), timestamp_ms)
                if index >= start:
                    world = image = visibility = None
                    if result.pose_world_landmarks and result.pose_landmarks:
                        world = [[round(p.x, 6), round(p.y, 6), round(p.z, 6)] for p in result.pose_world_landmarks[0]]
                        image = [[round(p.x, 6), round(p.y, 6), round(p.z, 6)] for p in result.pose_landmarks[0]]
                        visibility = [round(p.visibility, 4) for p in result.pose_landmarks[0]]
                    found.append((index, world, image, visibility, timestamp_ms))
                    since_report += 1
                    if updates is not None and since_report >= 5:
                        updates.put(since_report); since_report = 0
                index += 1
    finally:
        capture.release()
    if updates is not None and since_report:
        updates.put(since_report)
    return found


def infer_all(video_path: Path, total: int, fps: float, progress=None) -> dict[int, tuple]:
    """영상을 POSE_WORKERS 등분해 동시에 추론한다.

    추론이 전체 처리 시간의 80% 인데 MediaPipe 는 코어 하나만 쓴다. 프로세스로 나누면
    거의 선형으로 빨라진다 (실측: 4프로세스에서 2.9배). 워커마다 모델을 따로 올리므로
    메모리는 워커 수에 비례해 늘어난다 — 메모리가 적은 서버에서는 POSE_WORKERS 를 줄인다.
    """
    workers = min(POSE_WORKERS, max(1, total // 45)) if total else 1
    if workers <= 1:
        return {index: (world, image, visibility, ts) for index, world, image, visibility, ts in infer_range(str(MODEL_PATH), str(video_path), 0, total or 10 ** 9, 0, fps)}

    edges = [round(total * i / workers) for i in range(workers + 1)]
    poses: dict[int, tuple] = {}
    with multiprocessing.Manager() as manager:
        updates = manager.Queue()
        # fork 는 MediaPipe/TFLite 를 이미 적재한 부모를 복제해 문제가 생길 수 있어 spawn 을 쓴다
        with ProcessPoolExecutor(max_workers=workers, mp_context=multiprocessing.get_context("spawn")) as pool:
            futures = [pool.submit(infer_range, str(MODEL_PATH), str(video_path), edges[i], edges[i + 1] - edges[i], CHUNK_WARMUP, fps, updates)
                       for i in range(workers)]
            done_frames = 0
            while any(not future.done() for future in futures):
                try:
                    done_frames += updates.get(timeout=0.5)
                    if progress: progress(min(done_frames, total), total, "analyzing")
                except Exception:
                    pass
            for future in futures:
                for index, world, image, visibility, ts in future.result():
                    poses[index] = (world, image, visibility, ts)
    return poses


def render_previews(video_path: Path, poses: dict[int, tuple], source_hash: str, fps: float, width: int, height: int) -> tuple[Path, Path, int]:
    """원본을 다시 훑어 미리보기 영상을 순서대로 쓴다."""
    overlay_path = UPLOADS_PATH / f"{source_hash}.preview_overlay.mp4"
    skeleton_path = UPLOADS_PATH / f"{source_hash}.preview_3d_skeleton.mp4"
    capture = cv2.VideoCapture(str(video_path))
    overlay_writer = cv2.VideoWriter(str(overlay_path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
    skeleton_writer = cv2.VideoWriter(str(skeleton_path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (1200, 450))
    index = 0
    try:
        while True:
            ok, frame = capture.read()
            if not ok: break
            world, image, _, ts = poses.get(index, (None, None, None, None))
            time_s = (ts / 1000) if ts is not None else index / fps
            overlay_writer.write(draw_overlay(frame, image, index, time_s))
            skeleton_writer.write(draw_skeleton(world, index, time_s))
            index += 1
    finally:
        capture.release(); overlay_writer.release(); skeleton_writer.release()
    return overlay_path, skeleton_path, index


def analyze(source_hash: str, video_path: Path, progress=None) -> dict:
    """영상 전체를 훑어 포즈를 뽑고 미리보기 영상과 산출물을 만든다.

    `progress(done, total, stage)` 로 진행 상황을 알린다 — 동기 엔드포인트는 넘기지 않고,
    잡 엔드포인트만 넘겨서 앱이 진행률 막대를 그릴 수 있게 한다.
    """
    meta = probe(video_path)
    fps, width, height, total = meta["fps"], meta["width"], meta["height"], meta["frame_count"]

    poses = infer_all(video_path, total, fps, progress)

    if progress: progress(total, total, "rendering")
    overlay_path, skeleton_path, decoded = render_previews(video_path, poses, source_hash, fps, width, height)
    total = decoded or total

    frames, app_frames = [], []
    for index in range(total):
        world, image, visibility, ts = poses.get(index, (None, None, None, None))
        time_ms = ts if ts is not None else round(index / fps * 1000)
        if world and image and visibility:
            app_frames.append({"time_ms": time_ms, "world_landmarks": [{"x": p[0], "y": p[1], "z": p[2], "visibility": visibility[i]} for i, p in enumerate(world)], "image_landmarks": [{"x": p[0], "y": p[1], "z": p[2], "visibility": visibility[i]} for i, p in enumerate(image)]})
        frames.append({"frame": index, "time_s": round(time_ms / 1000, 6), "detected": bool(world), "world": world, "image": image, "visibility": visibility})

    # 미리보기 영상을 브라우저가 재생할 수 있는 코덱으로 바꾸는 단계. 긴 영상에서는
    # 눈에 띄게 걸리므로 분석과 구분해서 알린다.
    if progress: progress(total, total, "encoding")
    overlay_web_ready = to_web_h264(overlay_path)
    skeleton_web_ready = to_web_h264(skeleton_path)

    # 앱이 오버레이를 그릴 때 쓰는 형식만 따로 저장한다. 프로젝트를 다시 열 때
    # 전체 motion_3d.json(수십 MB)을 내려보내지 않기 위한 것이다.
    (UPLOADS_PATH / f"{source_hash}.app_frames.json").write_text(
        json.dumps({"width": width, "height": height, "fps": fps, "frames": app_frames}, ensure_ascii=False),
        encoding="utf-8")

    # 기록은 앱 밖으로 나가는 것이 목적이므로 서버의 절대 경로를 넣지 않는다
    payload = {"source": video_path.name, "model": f"mediapipe {MODEL_PATH.stem} (BlazePose GHUM 3D, 33 landmarks)", "fps": fps, "width": width, "height": height, "frame_count": total, "detected_frames": len(app_frames), "landmark_names": LANDMARK_NAMES, "coordinate_systems": {"world": "meters, origin = midpoint of hips", "image": "x,y normalized to [0,1] of frame"}, "frames": frames}
    # width/height 는 앱이 오버레이를 영상 위 정확한 위치에 그리기 위해 필요하다
    # (contentFit="contain" 이라 레터박스 여백을 빼야 좌표가 맞는다)
    return {"motion_format": "choreohub-motion-3d/v1", "frame_count": len(app_frames), "sample_rate_hz": fps, "source_sha256": source_hash, "width": width, "height": height, "video_url": f"/uploads/{video_path.name}", "overlay_web_ready": overlay_web_ready, "skeleton_web_ready": skeleton_web_ready, "frames": app_frames, **artifacts(source_hash, payload, overlay_path, skeleton_path)}


async def read_upload(video: UploadFile) -> bytes:
    if not (video.content_type or "").startswith("video/"): raise HTTPException(415, "A video file is required.")
    raw = await video.read()
    if len(raw) > 250 * 1024 * 1024: raise HTTPException(413, "Video must be 250 MB or smaller.")
    if not MODEL_PATH.exists(): raise HTTPException(500, "Pose model is not installed on the server.")
    return raw


@app.post("/v1/motions")
async def create_motion(video: UploadFile = File(...)) -> dict:
    """분석이 끝날 때까지 기다리는 동기 엔드포인트 (기존 클라이언트 호환용)."""
    source_hash, video_path = store_upload(await read_upload(video), video.filename)
    return analyze(source_hash, video_path)


@app.post("/v1/jobs")
async def create_job(video: UploadFile = File(...)) -> dict:
    """영상을 저장한 뒤 즉시 응답하고 분석은 백그라운드에서 돌린다.

    앱은 반환된 `video_url`/`width`/`height` 로 영상을 바로 띄우고, 사용자가 제목과
    라이선스를 입력하는 동안 `GET /v1/jobs/{job_id}` 로 진행률만 받아 가면 된다.
    """
    source_hash, video_path = store_upload(await read_upload(video), video.filename)
    meta = probe(video_path)
    job_id = uuid.uuid4().hex
    set_job(job_id, state="analyzing", done=0, total=meta["frame_count"], stage="analyzing")

    def run() -> None:
        try:
            def report(done: int, total: int, stage: str) -> None:
                set_job(job_id, done=done, total=total, stage=stage)
            set_job(job_id, result=analyze(source_hash, video_path, progress=report), state="done", stage="done")
        except Exception as error:  # noqa: BLE001 - 사용자에게 원인을 보여 준다
            traceback.print_exc()
            set_job(job_id, state="error", error=str(error))

    threading.Thread(target=run, daemon=True).start()
    return {"job_id": job_id, "video_url": f"/uploads/{video_path.name}", "source_sha256": source_hash, **meta}


@app.get("/v1/jobs/{job_id}")
def read_job(job_id: str) -> dict:
    job = get_job(job_id)
    if job is None: raise HTTPException(404, "Unknown job.")
    return job


# ══════════ 협업 공간 ══════════
#
# 앱 메모리가 아니라 서버에 상태를 둔다. 두 사람이 각자 브라우저에서 같은 작업을 열면
# 같은 데이터를 본다. 신원은 표시 이름 + user_id 뿐이다 (store.py 주석 참고).


def require_user(user_id: str | None) -> dict:
    user = store.get_user(user_id) if user_id else None
    if not user: raise HTTPException(401, "먼저 표시 이름을 등록해 주세요.")
    return user


def require_editor(project_id: str, user_id: str | None) -> dict:
    project = store.get_project(project_id, user_id)
    if not project: raise HTTPException(404, "작업을 찾을 수 없습니다.")
    if not store.can_edit(project_id, user_id): raise HTTPException(403, "이 작업을 수정할 권한이 없습니다.")
    return project


@app.post("/v1/users")
def register_user(name: str = Body(..., embed=True)) -> dict:
    """표시 이름만 받아 사용자를 만든다. 클라이언트가 user_id 를 보관한다."""
    user = store.create_user(name)
    store.seed_demo(user["user_id"])
    return user


@app.get("/v1/users/{user_id}")
def read_user(user_id: str) -> dict: return require_user(user_id)


@app.patch("/v1/users/{user_id}")
def patch_user(user_id: str, name: str = Body(..., embed=True)) -> dict:
    require_user(user_id)
    return store.rename_user(user_id, name)


@app.get("/v1/users/{user_id}/profile")
def read_profile(user_id: str, viewer_id: str | None = None) -> dict:
    """프로필 화면용 활동 요약. 남의 프로필이면 '연습 전용' 작업은 빠진다."""
    data = store.profile(user_id, viewer_id)
    if not data: raise HTTPException(404, "사용자를 찾을 수 없습니다.")
    return data


@app.post("/v1/users/{user_id}/follow")
def follow_user(user_id: str, viewer_id: str = Body(..., embed=True)) -> dict:
    require_user(viewer_id)
    if not store.get_user(user_id): raise HTTPException(404, "사용자를 찾을 수 없습니다.")
    store.follow(viewer_id, user_id)
    return store.follow_state(user_id, viewer_id)


@app.delete("/v1/users/{user_id}/follow")
def unfollow_user(user_id: str, viewer_id: str) -> dict:
    require_user(viewer_id)
    store.unfollow(viewer_id, user_id)
    return store.follow_state(user_id, viewer_id)


@app.get("/v1/community")
def read_community(viewer_id: str | None = None) -> dict:
    """탐색 화면 — 사람 목록과 공개 작업 피드."""
    return store.community(viewer_id)


@app.get("/v1/projects")
def read_projects(user_id: str) -> list[dict]:
    require_user(user_id)
    return store.list_projects(user_id)


@app.post("/v1/projects")
def make_project(user_id: str = Body(...), name: str = Body(""), license: str = Body("리믹스 허용"),
                 color: str = Body("#2454E6"), motion: dict | None = Body(None)) -> dict:
    require_user(user_id)
    return store.create_project(user_id, name, license, color, motion)


@app.get("/v1/projects/{project_id}")
def read_project(project_id: str, user_id: str | None = None) -> dict:
    project = store.get_project(project_id, user_id)
    if not project: raise HTTPException(404, "작업을 찾을 수 없습니다.")
    return project


@app.patch("/v1/projects/{project_id}")
def patch_project(project_id: str, user_id: str = Body(...), name: str | None = Body(None),
                  license: str | None = Body(None)) -> dict:
    require_editor(project_id, user_id)
    store.update_project(project_id, name, license)
    return store.get_project(project_id, user_id)


@app.delete("/v1/projects/{project_id}")
def remove_project(project_id: str, user_id: str) -> dict:
    """작업 삭제. **원작자만** 할 수 있다 — '직접 수정' 권한으로는 지울 수 없다."""
    require_user(user_id)
    project = store.get_project(project_id, user_id)
    if not project: raise HTTPException(404, "작업을 찾을 수 없습니다.")
    if not store.is_owner(project_id, user_id):
        raise HTTPException(403, "작업은 원작자만 삭제할 수 있습니다.")
    removed = store.delete_project(project_id)
    return {"deleted": True, "name": project["name"], **removed}


def require_admin(x_admin_token: str | None = Header(None)) -> None:
    admin_token = os.getenv("ADMIN_TOKEN")
    if not admin_token: raise HTTPException(503, "서버에 ADMIN_TOKEN이 설정돼 있지 않아요.")
    if not x_admin_token or x_admin_token != admin_token:
        raise HTTPException(403, "관리자 토큰이 올바르지 않아요.")


@app.post("/v1/admin/verify")
def admin_verify(_: None = Depends(require_admin)) -> dict:
    return {"ok": True}


@app.get("/v1/admin/users")
def admin_users(_: None = Depends(require_admin)) -> dict:
    return {"users": store.admin_list_users()}


@app.delete("/v1/admin/users/{user_id}")
def admin_delete_user_endpoint(user_id: str, _: None = Depends(require_admin)) -> dict:
    user = store.get_user(user_id)
    if not user: raise HTTPException(404, "사용자를 찾을 수 없습니다.")
    return {"name": user["name"], **store.delete_user(user_id)}


@app.get("/v1/admin/projects")
def admin_projects(_: None = Depends(require_admin)) -> dict:
    return {"projects": store.admin_list_projects()}


@app.delete("/v1/admin/projects/{project_id}")
def admin_delete_project_endpoint(project_id: str, _: None = Depends(require_admin)) -> dict:
    project = store.get_project(project_id)
    if not project: raise HTTPException(404, "작업을 찾을 수 없습니다.")
    removed = store.delete_project(project_id)
    return {"deleted": True, "name": project["name"], **removed}


@app.get("/v1/admin/practice")
def admin_practice(_: None = Depends(require_admin)) -> dict:
    return {"runs": store.admin_list_practice_runs()}


@app.delete("/v1/admin/practice/{run_id}")
def admin_delete_practice_endpoint(run_id: str, _: None = Depends(require_admin)) -> dict:
    store.admin_delete_practice_run(run_id)
    return {"deleted": True}


@app.get("/v1/projects/{project_id}/frames")
def read_frames(project_id: str) -> dict:
    """오버레이용 랜드마크. 파일이 커서 프로젝트 목록과 분리해 필요할 때만 받아 간다."""
    project = store.get_project(project_id)
    if not project: raise HTTPException(404, "작업을 찾을 수 없습니다.")
    if not project["sourceSha256"]: return {"width": None, "height": None, "frames": []}
    path = UPLOADS_PATH / f"{project['sourceSha256']}.app_frames.json"
    if not path.exists(): return {"width": project["videoWidth"], "height": project["videoHeight"], "frames": []}
    return json.loads(path.read_text(encoding="utf-8"))


# 기록 파일 목록. GitHub 저장소의 파일 목록처럼 무엇이 남았는지 보여 주고 내보낼 수 있게 한다.
ARTIFACTS = [
    ("motion_3d.json", "json", "전체 프레임 포즈 데이터", "모든 프레임의 world · image 좌표와 visibility"),
    ("app_frames.json", "json", "앱 재생용 좌표", "오버레이가 사용하는 간결한 형식"),
    ("motion_3d.csv", "csv", "프레임 × 관절 표", "한 행이 한 프레임의 한 관절"),
    ("pose_world_3d.npy", "npy", "world 3D 좌표 배열", "(프레임, 33, 3) float32 · 미터 · 골반 원점"),
    ("pose_image_3d.npy", "npy", "화면 좌표 배열", "(프레임, 33, 3) float32 · 0~1 정규화"),
    ("visibility.npy", "npy", "관절 신뢰도 배열", "(프레임, 33) float32"),
    ("preview_overlay.mp4", "mp4", "오버레이 미리보기", "원본 위에 뼈대를 얹은 H.264"),
    ("preview_3d_skeleton.mp4", "mp4", "3D 스켈레톤 영상", "정면 · 측면 · 상면 3면 뷰"),
]
PREVIEW_LINES = 500


def artifact_path(project: dict, key: str) -> Path | None:
    if not project.get("sourceSha256"): return None
    if key not in {item[0] for item in ARTIFACTS}: return None
    path = UPLOADS_PATH / f"{project['sourceSha256']}.{key}"
    return path if path.exists() else None


@app.get("/v1/projects/{project_id}/versions")
def read_versions(project_id: str, user_id: str | None = None) -> dict:
    """main 브랜치와 열린 제안. `canPropose`/`canDecide` 로 앱이 버튼을 결정한다."""
    project = store.get_project(project_id, user_id)
    if not project: raise HTTPException(404, "작업을 찾을 수 없습니다.")
    return {**store.list_versions(project_id),
            "canPropose": store.can_propose(project_id, user_id),
            "canDecide": store.can_edit(project_id, user_id)}


@app.post("/v1/projects/{project_id}/versions")
def make_version(project_id: str, user_id: str = Body(...), title: str = Body(""), note: str = Body(""),
                 start_ms: int | None = Body(None), end_ms: int | None = Body(None),
                 motion: dict | None = Body(None)) -> dict:
    """수정 제안을 만든다. '직접 수정' 권한이면 곧바로 main 에 반영된다.

    구간은 작품 타임라인 위의 밀리초다. 영상 길이와 대조해 검증한다 — 카운트 숫자였을 때는
    할 수 없던 일이다.
    """
    require_user(user_id)
    if not store.can_propose(project_id, user_id): raise HTTPException(403, "이 작업에 제안할 권한이 없습니다.")
    # 구간은 필수다. 구간 없는 버전은 전체를 주장해 버려서 다른 사람의 크레딧을 덮는다.
    # (원작 v1 은 create_project 안에서 직접 만들며, 그때만 전체 구간을 갖는다)
    if start_ms is None or end_ms is None:
        raise HTTPException(400, "고친 구간을 지정해 주세요. 어디를 고쳤는지 없으면 크레딧을 나눌 수 없습니다.")
    if start_ms < 0 or end_ms <= start_ms:
        raise HTTPException(400, "구간의 끝이 시작보다 뒤여야 합니다.")
    # 작품 길이를 넘는 구간은 허용한다 — 반영되면 작품이 그만큼 길어진다.
    # 다만 오타(예: 90:00)를 걸러야 하므로 10분 넘게 늘리는 것은 막는다.
    before = store.work_ms(project_id)
    if before and end_ms > before + 600_000:
        raise HTTPException(400, f"작품({store.fmt_ms(before)})을 10분 넘게 늘릴 수는 없습니다. 시간을 확인해 주세요.")
    merged = store.can_edit(project_id, user_id)
    result = store.create_version(project_id, user_id, title, note, start_ms, end_ms, motion, merged)
    after = store.work_ms(project_id)
    return {**result, "merged": merged, "workMs": after,
            "extended": after > before if before else False, "workMsBefore": before}


@app.post("/v1/projects/{project_id}/practice")
def make_practice_run(project_id: str, user_id: str = Body(...), reference_version_id: str | None = Body(None),
                      overall_score: float | None = Body(None), mirrored: bool = Body(False),
                      motion: dict = Body(...)) -> dict:
    """웹캠 실시간 연습 녹화를 남긴다 — versions 와 분리된 별도 기록이다.

    안무를 실제로 고친 게 아니라 개인 연습일 뿐이라 버전 이력·HEAD·크레딧에는 손대지 않는다.
    안무 수정(제안/반영)은 여전히 make_version 이 맡는다.
    """
    require_user(user_id)
    project = store.get_project(project_id)
    if not project: raise HTTPException(404, "작업을 찾을 수 없습니다.")
    return store.create_practice_run(project_id, user_id, reference_version_id, motion, overall_score, mirrored)


@app.get("/v1/projects/{project_id}/practice")
def read_practice_runs(project_id: str, user_id: str | None = None) -> dict:
    project = store.get_project(project_id)
    if not project: raise HTTPException(404, "작업을 찾을 수 없습니다.")
    return {"runs": store.list_practice_runs(project_id, user_id)}


@app.get("/v1/projects/{project_id}/versions/{version_id}/frames")
def read_version_frames(project_id: str, version_id: str) -> dict:
    """그 버전에 첨부된 클립의 랜드마크. 구간 영상만 따로 볼 때 쓴다."""
    row = store.connect().execute(
        "SELECT source_sha256, width, height FROM versions WHERE id = ? AND project_id = ?",
        (version_id, project_id)).fetchone()
    if not row: raise HTTPException(404, "버전을 찾을 수 없습니다.")
    if not row["source_sha256"]: return {"width": None, "height": None, "frames": []}
    path = UPLOADS_PATH / f"{row['source_sha256']}.app_frames.json"
    if not path.exists():
        return {"width": row["width"], "height": row["height"], "frames": []}
    return json.loads(path.read_text(encoding="utf-8"))


def _build_merge_filter(start_s: float, end_s: float, base_duration_s: float,
                        width: int, height: int, fps: float) -> str:
    """원본 영상의 [0, start_s), 구간 영상 전체, 원본 영상의 [end_s, 끝) 를 이 순서로 이어붙이는
    ffmpeg filter_complex 를 만든다. 세 조각의 해상도·fps 가 서로 달라도(휴대폰과 웹캠처럼)
    scale+pad+fps 로 맞춘 뒤 concat 해야 ffmpeg 이 에러 없이 이어붙인다."""
    conform = f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps}"
    filters = []
    labels = []
    if start_s > 0.05:
        filters.append(f"[0:v]trim=start=0:end={start_s:.3f},setpts=PTS-STARTPTS,{conform}[vpre]")
        labels.append("[vpre]")
    filters.append(f"[1:v]setpts=PTS-STARTPTS,{conform}[vseg]")
    labels.append("[vseg]")
    if end_s < base_duration_s - 0.05:
        filters.append(f"[0:v]trim=start={end_s:.3f}:end={base_duration_s:.3f},setpts=PTS-STARTPTS,{conform}[vpost]")
        labels.append("[vpost]")
    filters.append("".join(labels) + f"concat=n={len(labels)}:v=1:a=0[outv]")
    return ";".join(filters)


def _load_app_frames(source_sha256: str | None) -> list:
    if not source_sha256: return []
    path = UPLOADS_PATH / f"{source_sha256}.app_frames.json"
    if not path.exists(): return []
    return json.loads(path.read_text(encoding="utf-8")).get("frames", [])


def _remap_landmarks(landmarks: list, seg_w: int, seg_h: int, base_w: int, base_h: int) -> list:
    """구간 영상이 base 캔버스에 letterbox(scale+pad)될 때와 같은 변환을 좌표에도 적용한다.
    `_build_merge_filter`가 실제 화면에 적용하는 scale+pad 를 좌표가 따라가지 않으면
    두 영상의 화면비가 다를 때 스켈레톤이 몸에서 밀려 보인다."""
    if not seg_w or not seg_h or not landmarks: return landmarks
    scale = min(base_w / seg_w, base_h / seg_h)
    box_w, box_h = seg_w * scale, seg_h * scale
    offset_x, offset_y = (base_w - box_w) / 2, (base_h - box_h) / 2
    return [{**point, "x": (offset_x + point["x"] * box_w) / base_w,
             "y": (offset_y + point["y"] * box_h) / base_h} for point in landmarks]


def _build_merged_frames(base_hash: str, seg_hash: str | None, start_ms: int, end_ms: int, seg_duration_ms: float,
                         seg_width: int, seg_height: int, base_width: int, base_height: int) -> list:
    """합쳐진 영상과 정확히 같은 순서(원본 앞부분 → 구간 영상 → 원본 뒷부분)로, 같은
    시간 축 위에 랜드마크를 이어 붙인다 — `_build_merge_filter`가 영상 프레임에 적용하는
    편집과 프레임 단위로 일치해야 스켈레톤이 화면의 실제 움직임과 맞는다."""
    base_frames = _load_app_frames(base_hash)
    seg_frames = _load_app_frames(seg_hash)
    tail_offset = round(start_ms + seg_duration_ms - end_ms)
    merged = [frame for frame in base_frames if frame["time_ms"] < start_ms]
    merged += [{**frame, "time_ms": round(frame["time_ms"] + start_ms),
                "image_landmarks": _remap_landmarks(frame["image_landmarks"], seg_width, seg_height, base_width, base_height)}
               for frame in seg_frames]
    merged += [{**frame, "time_ms": frame["time_ms"] + tail_offset} for frame in base_frames if frame["time_ms"] >= end_ms]
    merged.sort(key=lambda frame: frame["time_ms"])
    return merged


@app.get("/v1/projects/{project_id}/versions/{version_id}/merged")
def merged_version_video(project_id: str, version_id: str) -> dict:
    """이 버전의 구간 영상을 지금 작업의 원본(HEAD) 영상 안에 그 구간만큼 이어붙여서,
    전체 안무 맥락에서 이 수정이 어떻게 보이는지 미리 볼 수 있게 한다. 함께 반환하는
    `frames`는 같은 순서·시간축으로 이어 붙인 랜드마크라, 재생 화면은 원본/구간 영상을
    볼 때와 똑같은 `MotionPlayer`+`PoseOverlay`로 오버레이·스켈레톤 모드를 그릴 수 있다
    — 합성 영상이라고 다른 재생 경험을 줄 이유가 없다.

    영상 파일(mp4)은 uploads/ 에 캐시해 두고 같은 버전을 다시 요청하면 ffmpeg 을 다시
    돌리지 않는다. 랜드마크는 이미 있는 두 app_frames.json 을 그때그때 이어 붙이기만
    하므로 굳이 캐시하지 않는다.
    """
    if not shutil.which("ffmpeg"): raise HTTPException(503, "서버에 ffmpeg 이 설치돼 있지 않아요.")
    project = store.get_project(project_id)
    if not project: raise HTTPException(404, "작업을 찾을 수 없습니다.")
    base_hash = project.get("sourceSha256")
    if not base_hash or not project.get("videoUrl"): raise HTTPException(404, "이 작업에는 원본 영상이 없어요.")
    base_path = UPLOADS_PATH / Path(project["videoUrl"]).name
    if not base_path.exists(): raise HTTPException(404, "원본 영상 파일을 찾을 수 없어요.")

    row = store.connect().execute(
        "SELECT source_sha256, video_url, start_ms, end_ms FROM versions WHERE id = ? AND project_id = ?",
        (version_id, project_id)).fetchone()
    if not row: raise HTTPException(404, "버전을 찾을 수 없습니다.")
    if not row["source_sha256"] or row["start_ms"] is None or row["end_ms"] is None:
        raise HTTPException(400, "이 버전은 구간 영상이 없거나 구간이 지정되지 않아 합칠 수 없어요.")
    seg_path = UPLOADS_PATH / Path(row["video_url"]).name
    if not seg_path.exists(): raise HTTPException(404, "구간 영상 파일을 찾을 수 없어요.")

    base_meta = probe(base_path)
    start_s, end_s = row["start_ms"] / 1000, row["end_ms"] / 1000

    output_path = UPLOADS_PATH / f"{base_hash}.merged.{version_id}.mp4"
    if not output_path.exists():
        base_duration_s = (base_meta["frame_count"] / base_meta["fps"]) if base_meta["fps"] else 0.0
        filter_complex = _build_merge_filter(
            start_s, end_s, base_duration_s, base_meta["width"], base_meta["height"], base_meta["fps"])
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(base_path), "-i", str(seg_path),
               "-filter_complex", filter_complex, "-map", "[outv]",
               "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
               "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output_path)]
        done = subprocess.run(cmd, capture_output=True)
        if done.returncode != 0 or not output_path.exists():
            output_path.unlink(missing_ok=True)
            raise HTTPException(502, f"영상을 합치지 못했어요: {done.stderr.decode('utf-8', 'ignore')[:300]}")

    # 실제 ffmpeg 이 이어붙이는 구간 영상 길이는 DB의 duration_ms(클라이언트가 채워 넣지
    # 않으면 비어 있을 수 있다)가 아니라 그 파일 자체다 — 같은 값을 여기서 다시 잰다.
    seg_meta = probe(seg_path)
    seg_duration_ms = (seg_meta["frame_count"] / seg_meta["fps"] * 1000) if seg_meta["fps"] else (end_s - start_s) * 1000
    merged_frames = _build_merged_frames(
        base_hash, row["source_sha256"], row["start_ms"], row["end_ms"], seg_duration_ms,
        seg_meta["width"], seg_meta["height"], base_meta["width"], base_meta["height"])

    return {"url": f"/uploads/{output_path.name}",
            "width": base_meta["width"], "height": base_meta["height"], "frames": merged_frames}


@app.post("/v1/projects/{project_id}/versions/{version_id}/head")
def set_head(project_id: str, version_id: str, user_id: str = Body(..., embed=True)) -> dict:
    """현재 버전(HEAD)을 지정한다. 이력은 지우지 않고 가리키는 곳만 바꾼다."""
    require_editor(project_id, user_id)
    try:
        store.set_head(project_id, version_id, user_id)
    except ValueError as error:
        raise HTTPException(409, str(error))
    return {**store.list_versions(project_id),
            "canPropose": store.can_propose(project_id, user_id),
            "canDecide": store.can_edit(project_id, user_id)}


@app.post("/v1/projects/{project_id}/versions/{version_id}/decide")
def decide(project_id: str, version_id: str, user_id: str = Body(...), accept: bool = Body(...)) -> dict:
    require_editor(project_id, user_id)
    try:
        return store.decide_version(project_id, version_id, user_id, accept)
    except ValueError as error:
        raise HTTPException(409, str(error))


ADVICE_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "segments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start": {"type": "number"},
                    "end": {"type": "number"},
                    "whatsWrong": {"type": "string"},
                    "why": {"type": "string"},
                    "howToFix": {"type": "string"},
                },
                "required": ["start", "end", "whatsWrong", "why", "howToFix"],
            },
        },
        "overallComment": {"type": "string"},
    },
    "required": ["segments", "overallComment"],
}


def genai_client() -> genai.Client:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(503, "서버에 GEMINI_API_KEY가 설정되지 않았어요.")
    return genai.Client(api_key=api_key)


def upload_and_wait_active(client: genai.Client, video_path: Path):
    """영상을 Gemini Files API 에 올리고 ACTIVE 상태가 될 때까지 기다린다.

    팀원의 route.ts 의 uploadAndWaitActive 와 동일한 폴링 정책(90초 타임아웃)이다.
    """
    mime_type = mimetypes.guess_type(video_path.name)[0] or "video/mp4"
    file = client.files.upload(file=str(video_path), config={"mime_type": mime_type})
    started_at = time.time()
    while str(file.state) in ("FileState.PROCESSING", "PROCESSING"):
        if time.time() - started_at > 90:
            raise HTTPException(502, "영상 처리 시간이 너무 오래 걸려요. 잠시 후 다시 시도해주세요.")
        time.sleep(2)
        file = client.files.get(name=file.name)
    if str(file.state) not in ("FileState.ACTIVE", "ACTIVE") or not file.uri or not file.mime_type:
        raise HTTPException(502, "영상 처리에 실패했어요. 다른 영상으로 시도해주세요.")
    return file


def build_numeric_prompt(segments: list[dict]) -> str:
    """팀원의 buildNumericPrompt 를 그대로 옮긴 것 — 문구/형식을 바꾸지 않는다."""
    lines = []
    for i, s in enumerate(segments):
        joints = ", ".join(f"{j['joint']}({j['avgDiffDeg']}도 차이)" for j in (s.get("worstJoints") or [])) or "특별히 두드러지는 관절 없음"
        lines.append(f"{i + 1}. \"{s.get('label', '구간')}\" ({s['start']:.1f}초~{s['end']:.1f}초): 일치율 {s.get('score', '?')}%, 차이가 큰 관절: {joints}")
    lines_text = "\n".join(lines)
    return (
        "당신은 댄스 안무 코치입니다. 첫 번째 영상은 사용자 영상이고, 두 번째는 레퍼런스 영상입니다. "
        "아래는 두 영상의 포즈를 분석해서 이미 정확하게 계산해 둔 결과입니다.\n\n"
        f"{lines_text}\n\n"
        "중요: 위 수치(퍼센트, 각도 차이)는 이미 정확히 계산되어 있습니다. 새로 추정하거나 다른 숫자를 만들어내지 마세요. "
        "이 수치를 근거로 삼되, 실제로 두 영상을 보고 무엇이 다른지, 왜 그런 차이가 나는지, 어떻게 고치면 좋을지 한국어로 자연스럽게 설명하세요.\n\n"
        "각 구간에 대해 위에 적힌 것과 정확히 같은 start/end 시간(초 단위 숫자)을 그대로 사용해서 whatsWrong(무엇이 다른지), "
        "why(그 동작에서 왜 그런 차이가 나는지), howToFix(구체적인 교정 방법)를 작성하고, overallComment에 전체 총평을 3문장 이내 한국어로 작성하세요."
    )


def build_descriptive_prompt(ref_title: str) -> str:
    """팀원의 buildDescriptivePrompt 를 그대로 옮긴 것 — 유튜브 레퍼런스는 포즈 데이터가 없어
    숫자를 계산할 수 없으므로, Gemini 에게 두 영상을 직접 보고 서술하게만 시킨다."""
    return (
        f"당신은 댄스 안무 코치입니다. 첫 번째 영상은 사용자가 춤춘 영상이고, 두 번째는 유튜브 레퍼런스 영상(\"{ref_title}\")입니다.\n\n"
        "중요: 이 비교는 포즈 인식 데이터가 없어서 정확한 퍼센트나 관절 각도를 계산할 방법이 전혀 없습니다. "
        "퍼센트, 점수, 각도 등 어떤 숫자도 절대 지어내지 마세요. 오직 두 영상을 직접 보고 관찰한 차이만 말로 서술하세요.\n\n"
        "사용자 영상 타임라인 기준으로 눈에 띄게 다른 구간들을 찾아서, 각각 whatsWrong(무엇이 다른지), "
        "why(왜 그런 차이가 나는 것 같은지), howToFix(교정 방법)를 한국어로 서술하고, overallComment에 전체 총평을 3문장 이내로 작성하세요."
    )


def resolve_version_video(project_id: str, version_id: str) -> Path:
    row = store.connect().execute(
        "SELECT video_url FROM versions WHERE id = ? AND project_id = ?",
        (version_id, project_id)).fetchone()
    if not row or not row["video_url"]:
        raise HTTPException(404, "그 버전에는 영상이 없어요.")
    path = UPLOADS_PATH / Path(row["video_url"]).name
    if not path.exists():
        raise HTTPException(404, "영상 파일을 찾을 수 없어요.")
    return path


@app.post("/v1/projects/{project_id}/advice")
def advice(project_id: str, user_id: str = Body(...), target_version_id: str = Body(...),
           compare: dict | None = Body(None),
           ref_youtube_url: str | None = Body(None), ref_youtube_title: str | None = Body(None)) -> dict:
    """이미 계산된 비교 결과(점수·관절 차이)를 근거로 Gemini 가 서술형 조언을 만든다.

    기본 모드(ref_youtube_url 없음): 첫 번째 영상은 비교 대상 버전(사용자 영상), 두 번째는
    프로젝트의 현재 HEAD(레퍼런스)다. 수치는 클라이언트가 이미 poseCompare.ts 로 계산해
    보낸 것이며, 프롬프트는 그 수치를 그대로 설명하도록 지시한다.

    유튜브 모드(ref_youtube_url 있음): 유튜브 레퍼런스는 포즈 데이터가 없으므로 점수·관절
    수치 없이 Gemini 가 두 영상을 직접 보고 서술하게만 한다 — 팀원의 route.ts 두 모드와 동일.
    """
    require_user(user_id)
    target_path = resolve_version_video(project_id, target_version_id)
    client = genai_client()
    try:
        target_file = upload_and_wait_active(client, target_path)
        if ref_youtube_url:
            contents = [
                build_descriptive_prompt(ref_youtube_title or "레퍼런스 영상"),
                genai_types.Part.from_uri(file_uri=target_file.uri, mime_type=target_file.mime_type),
                genai_types.Part.from_uri(file_uri=ref_youtube_url, mime_type="video/mp4"),
            ]
        else:
            project = store.get_project(project_id)
            if not project: raise HTTPException(404, "작업을 찾을 수 없습니다.")
            if not project.get("videoUrl"): raise HTTPException(404, "이 작업에는 영상이 없어요.")
            head_path = UPLOADS_PATH / Path(project["videoUrl"]).name
            if not head_path.exists(): raise HTTPException(404, "영상 파일을 찾을 수 없어요.")
            head_file = upload_and_wait_active(client, head_path)
            segments = (compare or {}).get("segments") or []
            contents = [
                build_numeric_prompt(segments),
                genai_types.Part.from_uri(file_uri=target_file.uri, mime_type=target_file.mime_type),
                genai_types.Part.from_uri(file_uri=head_file.uri, mime_type=head_file.mime_type),
            ]
        response = client.models.generate_content(
            model="gemini-3.6-flash",
            contents=contents,
            config=genai_types.GenerateContentConfig(
                response_mime_type="application/json",
                response_json_schema=ADVICE_JSON_SCHEMA,
            ),
        )
        text = response.text
        if not text: raise HTTPException(502, "Gemini 응답이 비어있어요.")
        return json.loads(text)
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(502, f"AI 조언 생성에 실패했어요: {error}")


@app.get("/v1/youtube/search")
def youtube_search(q: str) -> dict:
    """유튜브 레퍼런스 검색 — 임베드·크리에이티브 커먼즈 라이선스 영상만 보여준다(팀원의
    /api/youtube/search 필터와 동일). 포즈 비교는 하지 않는다 — 선택된 영상은 advice
    엔드포인트에서 Gemini 에게 URL 그대로 넘겨 서술형 조언만 받는다.
    """
    api_key = os.getenv("YOUTUBE_API_KEY")
    if not api_key: raise HTTPException(503, "서버에 YOUTUBE_API_KEY가 설정되지 않았어요.")
    if not q.strip(): return {"items": []}
    params = urllib.parse.urlencode({
        "part": "snippet", "type": "video", "maxResults": 12,
        "videoEmbeddable": "true", "videoLicense": "creativeCommon",
        "q": q, "key": api_key,
    })
    try:
        with urllib.request.urlopen(f"https://www.googleapis.com/youtube/v3/search?{params}", timeout=10) as response:
            data = json.loads(response.read())
    except Exception as error:
        raise HTTPException(502, f"유튜브 검색에 실패했어요: {error}")
    items = [{
        "videoId": item["id"]["videoId"],
        "title": item["snippet"]["title"],
        "channelTitle": item["snippet"]["channelTitle"],
        "thumbnailUrl": item["snippet"]["thumbnails"]["medium"]["url"],
    } for item in data.get("items", []) if item.get("id", {}).get("videoId")]
    return {"items": items}


@app.get("/v1/projects/{project_id}/files")
def read_files(project_id: str) -> dict:
    project = store.get_project(project_id)
    if not project: raise HTTPException(404, "작업을 찾을 수 없습니다.")
    files = []
    for key, kind, label, note in ARTIFACTS:
        path = artifact_path(project, key)
        if not path: continue
        files.append({"key": key, "kind": kind, "label": label, "note": note,
                      "name": export_name(project, key),
                      "url": f"/v1/projects/{project_id}/files/{key}/download",
                      "bytes": path.stat().st_size, "viewable": kind in ("json", "csv")})
    source = None
    if project.get("videoUrl"):
        candidate = UPLOADS_PATH / Path(project["videoUrl"]).name
        if candidate.exists():
            source = {"name": export_name(project, candidate.suffix.lstrip(".") or "mp4"),
                      "url": f"/v1/projects/{project_id}/files/source/download",
                      "bytes": candidate.stat().st_size}
    return {"format": "choreohub-motion-3d/v1", "files": files, "source": source}


def export_name(project: dict, key: str) -> str:
    """내보내는 파일 이름을 해시 대신 작업 이름으로 준다 — 기록은 사람이 받아 보관한다."""
    base = re.sub(r"[^\w가-힣 .-]", "", project.get("name") or "choreo").strip().replace(" ", "_") or "choreo"
    return f"{base}.{key}"


@app.get("/v1/projects/{project_id}/files/{key}/download")
def download_artifact(project_id: str, key: str):
    """`Content-Disposition: attachment` 로 내려보낸다.

    브라우저의 `<a download>` 는 cross-origin URL 에서 무시되므로(앱 8081, 파일 8000)
    정적 경로를 그대로 링크하면 다운로드가 아니라 페이지 이동이 된다.
    """
    project = store.get_project(project_id)
    if not project: raise HTTPException(404, "작업을 찾을 수 없습니다.")
    if key == "source":
        if not project.get("videoUrl"): raise HTTPException(404, "원본 영상이 없습니다.")
        path = UPLOADS_PATH / Path(project["videoUrl"]).name
        name = export_name(project, path.suffix.lstrip(".") or "mp4")
    else:
        found = artifact_path(project, key)
        if not found: raise HTTPException(404, "파일이 없습니다.")
        path, name = found, export_name(project, key)
    if not path.exists(): raise HTTPException(404, "파일이 없습니다.")
    return FileResponse(path, filename=name, media_type="application/octet-stream")


@app.get("/v1/projects/{project_id}/files/{key}/preview")
def read_file_preview(project_id: str, key: str) -> dict:
    """텍스트 파일의 앞부분만 줄 단위로 돌려준다 (GitHub 의 blob 보기와 같은 용도).

    JSON 은 한 줄로 저장되어 그대로 보면 읽을 수 없다. 전체를 파싱해 들여쓰기로 다시 쓴 뒤
    앞부분을 잘라 보낸다 — 3MB 정도는 서버에서 수십 ms 면 된다.
    """
    project = store.get_project(project_id)
    if not project: raise HTTPException(404, "작업을 찾을 수 없습니다.")
    path = artifact_path(project, key)
    if not path: raise HTTPException(404, "파일이 없습니다.")
    if not key.endswith((".json", ".csv")): raise HTTPException(415, "미리보기를 지원하지 않는 형식입니다.")

    if key.endswith(".json"):
        try:
            pretty = json.dumps(json.loads(path.read_text(encoding="utf-8")), ensure_ascii=False, indent=2)
        except Exception:
            raise HTTPException(500, "JSON 을 읽지 못했습니다.")
        lines = pretty.split("\n")
    else:
        with path.open(encoding="utf-8") as handle:
            lines = [line.rstrip("\n") for _, line in zip(range(PREVIEW_LINES + 1), handle)]
        with path.open(encoding="utf-8") as handle:
            total = sum(1 for _ in handle)
        return {"name": path.name, "bytes": path.stat().st_size, "lines": lines[:PREVIEW_LINES],
                "shown": min(len(lines), PREVIEW_LINES), "total": total,
                "truncated": total > PREVIEW_LINES, "url": f"/v1/projects/{project_id}/files/{key}/download"}

    return {"name": path.name, "bytes": path.stat().st_size, "lines": lines[:PREVIEW_LINES],
            "shown": min(len(lines), PREVIEW_LINES), "total": len(lines),
            "truncated": len(lines) > PREVIEW_LINES, "url": f"/v1/projects/{project_id}/files/{key}/download"}


@app.post("/v1/projects/{project_id}/collaborators")
def add_collaborator(project_id: str, user_id: str = Body(...), name: str = Body(...), role: str = Body(""),
                     counts: str = Body(""), permission: str = Body("수정 제안")) -> dict:
    require_editor(project_id, user_id)
    if not name.strip(): raise HTTPException(400, "이름이 필요합니다.")
    store.add_collaborator(project_id, name, role, counts, permission)
    return store.get_project(project_id, user_id)


@app.patch("/v1/projects/{project_id}/collaborators/{collab_id}")
def patch_collaborator(project_id: str, collab_id: str, user_id: str = Body(...), name: str = Body(...),
                       role: str = Body(""), counts: str = Body(""), permission: str = Body("수정 제안")) -> dict:
    require_editor(project_id, user_id)
    store.update_collaborator(collab_id, name, role, counts, permission)
    return store.get_project(project_id, user_id)


@app.delete("/v1/projects/{project_id}/collaborators/{collab_id}")
def delete_collaborator(project_id: str, collab_id: str, user_id: str) -> dict:
    require_editor(project_id, user_id)
    store.remove_collaborator(collab_id)
    return store.get_project(project_id, user_id)


@app.get("/v1/invites/{code}")
def peek_invite(code: str) -> dict:
    """참여 전에 어떤 작업인지 먼저 보여 준다."""
    project = store.project_by_code(code)
    if not project: raise HTTPException(404, "그런 초대 코드가 없습니다.")
    return {"id": project["id"], "name": project["name"], "ownerName": project["ownerName"],
            "license": project["license"], "collaborators": len(project["collaborators"])}


@app.post("/v1/invites/{code}/join")
def join_invite(code: str, user_id: str = Body(..., embed=True)) -> dict:
    require_user(user_id)
    project = store.join_by_code(code, user_id)
    if not project: raise HTTPException(404, "그런 초대 코드가 없습니다.")
    return project
