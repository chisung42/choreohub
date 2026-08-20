/**
 * 웹캠 실시간 연습 엔진 — 팀원 프로젝트의 lib/mediapipe.ts, lib/poseExtraction.ts,
 * lib/interpolatePose.ts, lib/live/livePhrases.ts 를 하나로 모아 그대로 옮긴 것.
 *
 * 브라우저 전용이다(HTMLVideoElement, WebAssembly, requestVideoFrameCallback). 이 파일은
 * 웹 화면(Live 스크린)에서만 import 되고, 네이티브 빌드는 그 화면 진입 자체를 막는다.
 */
import type { NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision';
import { JOINT_NAMES, type PoseFrame, type PosePersonFrame, type WorstJoint } from './poseCompare';

// ── 포즈 인식 모델 로딩 (mediapipe.ts) ──────────────────────────────────────
//
// npm의 @mediapipe/tasks-vision 을 `import()`/`require()` 로 직접 불러오면 Metro가
// 그 패키지 내부의 (Emscripten 이 생성한) `import(t.toString())` 같은 동적 import를
// 정적으로 분석하다가 "Invalid call" 로 빌드 자체가 깨진다(Webpack/Vite는 이 패턴을
// 허용하지만 Metro는 리터럴 문자열이 아닌 동적 import를 거부한다). 그래서 이 패키지는
// Metro 의존성 그래프에 절대 들어오지 않게 하고, 브라우저에 <script> 태그로 직접 얹어
// 전역(window.Vision)으로만 꺼내 쓴다 — 구글의 공식 <script src> 사용법과 같은 방식이다.
const VISION_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.js';
const WASM_BASE_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const MODEL_ASSET_PATH = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const LOAD_TIMEOUT_MS = 60000;

let landmarkerPromise: Promise<PoseLandmarker> | null = null;
let visionGlobalPromise: Promise<any> | null = null;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

function loadVisionGlobal(): Promise<any> {
  if ((window as any).Vision) return Promise.resolve((window as any).Vision);
  if (!visionGlobalPromise) {
    visionGlobalPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = VISION_SCRIPT_URL;
      script.crossOrigin = 'anonymous';
      script.onload = () => (window as any).Vision ? resolve((window as any).Vision) : reject(new Error('vision_bundle.js 로딩 후 전역을 찾지 못했어요.'));
      script.onerror = () => reject(new Error('포즈 인식 라이브러리를 불러오지 못했어요.'));
      document.head.appendChild(script);
    });
  }
  return visionGlobalPromise;
}

export function getPoseLandmarker(): Promise<PoseLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = withTimeout(
      (async () => {
        const { FilesetResolver, PoseLandmarker: PL } = await loadVisionGlobal();
        const vision = await FilesetResolver.forVisionTasks(WASM_BASE_PATH);
        return PL.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_ASSET_PATH, delegate: 'CPU' },
          runningMode: 'VIDEO',
          numPoses: 1,
        });
      })(),
      LOAD_TIMEOUT_MS,
      '포즈 인식 모델 로딩이 60초 넘게 걸려 중단했어요. 네트워크 상태를 확인해주세요.',
    ).catch((err) => { landmarkerPromise = null; throw err; });
  }
  return landmarkerPromise;
}

// ── 타임스탬프 · 프레임 그리드 (poseExtraction.ts) ──────────────────────────
export const SAMPLE_FPS = 10;

export interface VideoFrameCallbackMetadata { mediaTime: number }
export type RVFCVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, metadata: VideoFrameCallbackMetadata) => void) => number;
};

/** MediaPipe 싱글턴 그래프는 타임스탬프가 계속 증가해야 한다 — 세션마다 겹치지 않는
 *  구간을 예약해서 두 번째 세션이 0ms 부터 다시 시작해도 충돌하지 않게 한다. */
let nextTimestampOffsetMs = 0;
export function reserveTimestampSession(estimatedDurationSec: number): number {
  const sessionOffsetMs = nextTimestampOffsetMs;
  nextTimestampOffsetMs = sessionOffsetMs + Math.round(Math.max(0, estimatedDurationSec) * 1000) + 1000;
  return sessionOffsetMs;
}
export function toGraphTimestampMs(sessionOffsetMs: number, localSec: number): number {
  return sessionOffsetMs + Math.round(localSec * 1000);
}

export function toPosePersonFrames(landmarksList: NormalizedLandmark[][]): PosePersonFrame[] {
  return landmarksList.map((landmarks, personIndex) => ({
    id: personIndex,
    landmarks: landmarks.map((p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility ?? 1 })),
  }));
}

/** `video`(레퍼런스 영상)의 재생 시계를 기준으로 고정 그리드(0, 0.1, 0.2, ...)에서 onTick 을 부른다. */
export function driveFrameGrid(video: RVFCVideo, stepSec: number, onTick: (t: number) => void): { stop: () => void } {
  let nextGridTime = 0;
  let stopped = false;
  function onFrame(_now: number, metadata: VideoFrameCallbackMetadata) {
    if (stopped) return;
    const t = metadata.mediaTime;
    if (t >= nextGridTime - 0.005) {
      while (nextGridTime <= t) nextGridTime += stepSec;
      onTick(t);
    }
    if (!stopped) video.requestVideoFrameCallback!(onFrame);
  }
  video.requestVideoFrameCallback!(onFrame);
  return { stop: () => { stopped = true; } };
}

// ── 포즈 보간 (interpolatePose.ts) ──────────────────────────────────────────
function lerp(a: number, b: number, ratio: number): number { return a + (b - a) * ratio; }

/** 레퍼런스 포즈는 ~10fps 로만 샘플돼 있어서, 두 샘플 사이를 선형 보간해 매 그리드 틱마다
 *  자연스러운 값을 준다. */
export function interpolatePoseAt(poseData: PoseFrame[], t: number): PosePersonFrame[] {
  if (poseData.length === 0) return [];
  if (poseData.length === 1 || t <= poseData[0].timestamp) return poseData[0].persons;
  const last = poseData[poseData.length - 1];
  if (t >= last.timestamp) return last.persons;

  let lo = 0, hi = poseData.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (poseData[mid].timestamp <= t) lo = mid; else hi = mid;
  }
  const a = poseData[lo], b = poseData[hi];
  const span = b.timestamp - a.timestamp;
  const ratio = span > 0 ? (t - a.timestamp) / span : 0;
  const count = Math.min(a.persons.length, b.persons.length);
  const persons: PosePersonFrame[] = [];
  for (let i = 0; i < count; i++) {
    const pa = a.persons[i], pb = b.persons[i];
    const landmarks = pa.landmarks.map((la, idx) => {
      const lb = pb.landmarks[idx];
      if (!lb) return la;
      return { x: lerp(la.x, lb.x, ratio), y: lerp(la.y, lb.y, ratio), z: lerp(la.z, lb.z, ratio), visibility: lerp(la.visibility, lb.visibility, ratio) };
    });
    persons.push({ id: pa.id, landmarks });
  }
  return persons;
}

// ── 즉석 코칭 문구 (livePhrases.ts) ──────────────────────────────────────────
// 실시간 루프 안에서는 AI 호출을 쓸 수 없다(수 초~수십 초 지연) — 로컬 텍스트로만 구성.
const PHRASES: Record<(typeof JOINT_NAMES)[number], string> = {
  '왼쪽 팔꿈치': '왼팔 각도를 맞춰보세요',
  '오른쪽 팔꿈치': '오른팔 각도를 맞춰보세요',
  '왼쪽 어깨': '왼팔 높이를 맞춰보세요',
  '오른쪽 어깨': '오른팔 높이를 맞춰보세요',
  '왼쪽 무릎': '왼쪽 다리 각도를 맞춰보세요',
  '오른쪽 무릎': '오른쪽 다리 각도를 맞춰보세요',
  '왼쪽 고관절': '왼쪽 다리 방향을 맞춰보세요',
  '오른쪽 고관절': '오른쪽 다리 방향을 맞춰보세요',
  '몸통 기울기': '상체 기울기를 맞춰보세요',
  '어깨라인 회전': '몸을 돌리는 각도를 맞춰보세요',
  '골반라인 회전': '골반 방향을 맞춰보세요',
  '머리 기울기': '고개 각도를 맞춰보세요',
};
const PRAISE = ['좋아요!', '잘하고 있어요!', '정확해요!', '그대로 계속!'];

export function phraseForJoint(joint: string): string {
  return PHRASES[joint as (typeof JOINT_NAMES)[number]] ?? '동작을 조금 더 맞춰보세요';
}
export function praisePhrase(seed: number): string {
  return PRAISE[Math.abs(Math.floor(seed)) % PRAISE.length];
}

export type { WorstJoint };
