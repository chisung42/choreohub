// 팀원의 Next.js 프로젝트(src/lib/compare/pose-compare.ts, src/lib/compare/types.ts)에서
// 그대로 가져온 포즈 비교 엔진. 알고리즘은 한 글자도 바꾸지 않았다 — vitest로 검증된
// DTW 정렬·잡음 보정 로직을 다시 짤 이유가 없다. 바뀐 것은 입력 타입뿐이다: 팀원 쪽은
// 다인 지원을 위해 프레임마다 persons[] 배열을 두는데, 이 앱은 한 사람만 추적한다
// (App.tsx MotionFrame). motionFramesToPoseFrames()가 그 경계를 잇는다.

export interface PoseLandmarkPoint {
  x: number;
  y: number;
  z: number;
  visibility: number;
}

export interface PosePersonFrame {
  id: number;
  landmarks: PoseLandmarkPoint[]; // 33 BlazePose landmarks
}

export interface PoseFrame {
  timestamp: number; // seconds, from video start
  persons: PosePersonFrame[];
}

/** 이 앱의 MotionFrame(단일 인물, time_ms)을 비교 엔진이 기대하는 다인 프레임 형태로 편다. */
export function motionFramesToPoseFrames(
  frames: { time_ms: number; image_landmarks: PoseLandmarkPoint[] }[],
): PoseFrame[] {
  return frames.map((f) => ({
    timestamp: f.time_ms / 1000,
    persons: [{ id: 0, landmarks: f.image_landmarks }],
  }));
}

export interface WorstJoint {
  joint: string;
  avgDiffDeg: number;
}

export interface CompareSegment {
  label: string;
  start: number;
  end: number;
  score: number;
  worstJoints: WorstJoint[];
  /** 이 구간 프레임의 상당수가 카메라 거리/각도 때문에 관절이 안 보여서 비교에서
   *  제외됐다는 뜻 — 점수 자체는 정상 계산되지만 신뢰도가 낮을 수 있음을 알려준다. */
  lowVisibility: boolean;
}

export interface FrameScore {
  t: number;
  score: number;
}

/** 포즈 비교 엔진의 순수 계산 결과 — 어느 경로에서 왔는지는 모른다. */
export interface PoseCompareScore {
  overallScore: number; // 0~100, 소수 1자리
  mirrored: boolean;
  segments: CompareSegment[];
  frameScores: FrameScore[];
  /** segments 중 하나라도 lowVisibility면 true. */
  lowVisibility: boolean;
}

export interface TimeRange {
  start: number;
  end: number;
}

export interface RangePairResult {
  label?: string;
  refRange: TimeRange;
  userRange: TimeRange;
  score: number;
  mirrored: boolean;
  worstJoints: WorstJoint[];
  lengthWarning: boolean;
  lowVisibility: boolean;
}

const VISIBILITY_THRESHOLD = 0.5;

export const JOINT_NAMES = [
  "왼쪽 팔꿈치",
  "오른쪽 팔꿈치",
  "왼쪽 어깨",
  "오른쪽 어깨",
  "왼쪽 무릎",
  "오른쪽 무릎",
  "왼쪽 고관절",
  "오른쪽 고관절",
  "몸통 기울기",
  "어깨라인 회전",
  "골반라인 회전",
  "머리 기울기",
] as const;

const LEFT_SHOULDER = 11;
const RIGHT_SHOULDER = 12;
const LEFT_ELBOW = 13;
const RIGHT_ELBOW = 14;
const LEFT_WRIST = 15;
const RIGHT_WRIST = 16;
const LEFT_HIP = 23;
const RIGHT_HIP = 24;
const LEFT_KNEE = 25;
const RIGHT_KNEE = 26;
const LEFT_ANKLE = 27;
const RIGHT_ANKLE = 28;
const LEFT_EAR = 7;
const RIGHT_EAR = 8;

// (a,b) 는 서로 스왑되는 좌우 대칭 랜드마크 인덱스. 0(코)처럼 중앙에 있는 건 제외.
const MIRROR_PAIRS: [number, number][] = [
  [1, 4],
  [2, 5],
  [3, 6],
  [7, 8],
  [9, 10],
  [11, 12],
  [13, 14],
  [15, 16],
  [17, 18],
  [19, 20],
  [21, 22],
  [23, 24],
  [25, 26],
  [27, 28],
  [29, 30],
  [31, 32],
];

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function primaryLandmarks(frame: PoseFrame): PoseLandmarkPoint[] | null {
  return frame.persons[0]?.landmarks ?? null;
}

/** 원점을 좌우 엉덩이 중점으로, 스케일을 몸통 길이(어깨중점~엉덩이중점)로 정규화한다. */
export function normalizeLandmarks(landmarks: PoseLandmarkPoint[]): PoseLandmarkPoint[] {
  const lh = landmarks[LEFT_HIP];
  const rh = landmarks[RIGHT_HIP];
  const ls = landmarks[LEFT_SHOULDER];
  const rs = landmarks[RIGHT_SHOULDER];
  const originX = (lh.x + rh.x) / 2;
  const originY = (lh.y + rh.y) / 2;
  const shoulderMidX = (ls.x + rs.x) / 2;
  const shoulderMidY = (ls.y + rs.y) / 2;
  const scale = Math.hypot(shoulderMidX - originX, shoulderMidY - originY) || 1;

  return landmarks.map((p) => ({
    x: (p.x - originX) / scale,
    y: (p.y - originY) / scale,
    z: p.z / scale,
    visibility: p.visibility,
  }));
}

/** 좌우를 반전한다(거울모드 비교용) — x 부호를 뒤집고 좌/우 라벨이 붙은 랜드마크를 스왑. */
export function mirrorLandmarks(landmarks: PoseLandmarkPoint[]): PoseLandmarkPoint[] {
  const out = landmarks.map((p) => ({ ...p, x: -p.x }));
  for (const [a, b] of MIRROR_PAIRS) {
    const tmp = out[a];
    out[a] = out[b];
    out[b] = tmp;
  }
  return out;
}

function angleBetween(ax: number, ay: number, bx: number, by: number): number {
  const magA = Math.hypot(ax, ay);
  const magB = Math.hypot(bx, by);
  if (magA < 1e-9 || magB < 1e-9) return 0;
  const cos = Math.min(1, Math.max(-1, (ax * bx + ay * by) / (magA * magB)));
  return (Math.acos(cos) * 180) / Math.PI;
}

function visOk(...pts: (PoseLandmarkPoint | undefined)[]): boolean {
  return pts.every((p) => !!p && p.visibility >= VISIBILITY_THRESHOLD);
}

function jointAngle(
  lm: PoseLandmarkPoint[],
  aIdx: number,
  bIdx: number,
  cIdx: number,
): number | null {
  const a = lm[aIdx];
  const b = lm[bIdx];
  const c = lm[cIdx];
  if (!visOk(a, b, c)) return null;
  return angleBetween(a.x - b.x, a.y - b.y, c.x - b.x, c.y - b.y);
}

function lineAngleVsAxis(
  lm: PoseLandmarkPoint[],
  fromIdx: number,
  toIdx: number,
  axisX: number,
  axisY: number,
): number | null {
  const from = lm[fromIdx];
  const to = lm[toIdx];
  if (!visOk(from, to)) return null;
  return angleBetween(to.x - from.x, to.y - from.y, axisX, axisY);
}

/**
 * 정규화된 랜드마크에서 12개 관절 각도를 계산한다(도 단위, JOINT_NAMES 순서와 대응).
 * 관련 랜드마크 중 하나라도 visibility가 낮으면 해당 값은 null.
 */
export function computeJointAngles(lm: PoseLandmarkPoint[]): (number | null)[] {
  const angles: (number | null)[] = [];

  angles.push(jointAngle(lm, LEFT_SHOULDER, LEFT_ELBOW, LEFT_WRIST));
  angles.push(jointAngle(lm, RIGHT_SHOULDER, RIGHT_ELBOW, RIGHT_WRIST));
  angles.push(jointAngle(lm, LEFT_HIP, LEFT_SHOULDER, LEFT_ELBOW));
  angles.push(jointAngle(lm, RIGHT_HIP, RIGHT_SHOULDER, RIGHT_ELBOW));
  angles.push(jointAngle(lm, LEFT_HIP, LEFT_KNEE, LEFT_ANKLE));
  angles.push(jointAngle(lm, RIGHT_HIP, RIGHT_KNEE, RIGHT_ANKLE));
  angles.push(jointAngle(lm, LEFT_SHOULDER, LEFT_HIP, LEFT_KNEE));
  angles.push(jointAngle(lm, RIGHT_SHOULDER, RIGHT_HIP, RIGHT_KNEE));

  // 몸통 기울기: 엉덩이중점 -> 어깨중점 벡터 vs 수직축
  if (visOk(lm[LEFT_HIP], lm[RIGHT_HIP], lm[LEFT_SHOULDER], lm[RIGHT_SHOULDER])) {
    const hipMidX = (lm[LEFT_HIP].x + lm[RIGHT_HIP].x) / 2;
    const hipMidY = (lm[LEFT_HIP].y + lm[RIGHT_HIP].y) / 2;
    const shMidX = (lm[LEFT_SHOULDER].x + lm[RIGHT_SHOULDER].x) / 2;
    const shMidY = (lm[LEFT_SHOULDER].y + lm[RIGHT_SHOULDER].y) / 2;
    angles.push(angleBetween(shMidX - hipMidX, shMidY - hipMidY, 0, -1));
  } else {
    angles.push(null);
  }

  angles.push(lineAngleVsAxis(lm, LEFT_SHOULDER, RIGHT_SHOULDER, 1, 0));
  angles.push(lineAngleVsAxis(lm, LEFT_HIP, RIGHT_HIP, 1, 0));
  angles.push(lineAngleVsAxis(lm, LEFT_EAR, RIGHT_EAR, 1, 0));

  return angles;
}

/** 가중 각도차 평균(도). 둘 중 하나라도 null인 관절은 제외하고 남은 것끼리 평균(=가중치 재분배). */
export function angleSetDistance(a: (number | null)[], b: (number | null)[]): number {
  const diffs: number[] = [];
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    if (av == null || bv == null) continue;
    diffs.push(Math.abs(av - bv));
  }
  if (diffs.length === 0) return 90; // 비교 불가 프레임: 중간값으로 페널티
  return average(diffs);
}

export interface DTWResult {
  path: Array<[number, number]>;
  avgCost: number;
}

/** Sakoe-Chiba band 제약 DTW. band는 (max(n,m)*bandRatio) 와 |n-m| 중 큰 값을 써서
 *  코너(n,m)에 항상 도달 가능하게 한다. */
export function dtwAlign(
  seqA: Array<(number | null)[]>,
  seqB: Array<(number | null)[]>,
  bandRatio = 0.1,
): DTWResult {
  const n = seqA.length;
  const m = seqB.length;
  if (n === 0 || m === 0) return { path: [], avgCost: 90 };

  const band = Math.max(1, Math.round(Math.max(n, m) * bandRatio), Math.abs(n - m));
  const INF = Infinity;
  const cost: Float64Array[] = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(INF));
  cost[0][0] = 0;

  for (let i = 1; i <= n; i++) {
    const jStart = Math.max(1, i - band);
    const jEnd = Math.min(m, i + band);
    for (let j = jStart; j <= jEnd; j++) {
      const d = angleSetDistance(seqA[i - 1], seqB[j - 1]);
      const best = Math.min(cost[i - 1][j], cost[i][j - 1], cost[i - 1][j - 1]);
      cost[i][j] = d + best;
    }
  }

  const path: Array<[number, number]> = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    path.push([i - 1, j - 1]);
    const diag = cost[i - 1][j - 1];
    const up = cost[i - 1][j];
    const left = cost[i][j - 1];
    const min = Math.min(diag, up, left);
    if (min === diag) {
      i--;
      j--;
    } else if (min === up) {
      i--;
    } else {
      j--;
    }
  }
  path.reverse();

  const avgCost =
    path.length > 0
      ? average(path.map(([pi, pj]) => angleSetDistance(seqA[pi], seqB[pj])))
      : 90;

  return { path, avgCost };
}

/** 프레임이 maxFrames를 넘으면 균등 다운샘플링한다. */
export function downsampleFrames(frames: PoseFrame[], maxFrames = 3000): PoseFrame[] {
  if (frames.length <= maxFrames) return frames;
  const step = frames.length / maxFrames;
  const out: PoseFrame[] = [];
  for (let i = 0; i < maxFrames; i++) out.push(frames[Math.floor(i * step)]);
  return out;
}

/** 지정한 fps 간격으로 프레임을 솎아낸다(슬라이딩 윈도우 1단계 탐색용). */
export function downsampleToFps(frames: PoseFrame[], fps: number): PoseFrame[] {
  if (frames.length === 0) return [];
  const step = 1 / fps;
  const out: PoseFrame[] = [];
  let last = -Infinity;
  for (const f of frames) {
    if (f.timestamp - last >= step - 1e-6) {
      out.push(f);
      last = f.timestamp;
    }
  }
  return out;
}

function anglesForFrames(frames: PoseFrame[], mirror: boolean): Array<(number | null)[]> {
  return frames.map((f) => {
    const lm = primaryLandmarks(f);
    if (!lm) return new Array(JOINT_NAMES.length).fill(null);
    const normalized = normalizeLandmarks(lm);
    return computeJointAngles(mirror ? mirrorLandmarks(normalized) : normalized);
  });
}

function frameScoreFromDistance(dist: number): number {
  return clamp01(1 - dist / 180) * 100;
}

/**
 * 포즈 추출은 완벽히 결정론적이지 않아서(영상 디코딩 타이밍 등) 같은 영상을 두 번 추출해도
 * 관절 각도가 미세하게(1~2도 안팎) 다르게 나올 수 있다. 이 정도는 "다른 동작"이 아니라
 * 측정 잡음이므로 정답으로 쳐준다 — 97점은 평균 관절 각도 차이 약 5.4도까지 허용한다는 뜻.
 *
 * 중요: 이 보정은 반드시 "프레임 하나하나"에 적용해야 한다. 만약 구간/전체 평균 점수에
 * 적용하면, 대부분 잘 맞고 한 동작만 크게 틀린 경우에도 평균이 97을 넘어 "정답"으로
 * 뭉개져버려서 그 결정적인 실수를 놓치게 된다. 프레임 단위로 보정하면 잡음 낀 프레임만
 * 100으로 올라가고, 진짜 크게 틀린 프레임은 그대로 낮은 점수를 유지해 평균을 끌어내린다.
 */
export const MATCH_THRESHOLD = 97;

function applyMatchThreshold(score: number): number {
  return score >= MATCH_THRESHOLD ? 100 : score;
}

/**
 * 카메라와 너무 가까이서 찍어 몸의 일부가 프레임 밖으로 나가거나(다리 잘림 등), 각도가
 * 안 좋아서 랜드마크 visibility가 낮으면 그 관절은 비교에서 자동 제외된다(가중치
 * 재분배). 문제는 제외되는 관절이 너무 많으면 남은 몇 개만으로 계산한 점수를 그대로
 * 믿기 어렵다는 것 — 이 비율(12개 중 실제로 비교에 쓰인 관절 수)이 낮은 구간은
 * lowVisibility로 표시해서 화면에 경고를 띄운다.
 */
const VISIBILITY_WARNING_COVERAGE = 0.7;

function jointCoverage(a: (number | null)[], b: (number | null)[]): number {
  let valid = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] != null && b[i] != null) valid++;
  }
  return valid / JOINT_NAMES.length;
}

/**
 * 실시간 연습용 즉석 채점. 배치 비교(compareSequences)와 다르게 DTW 정렬이 필요 없다 —
 * 사용자와 레퍼런스가 이미 같은 재생 시계를 공유하고 있어서(레퍼런스 영상 재생 시각 =
 * 사용자 프레임 타임스탬프) 그 순간 프레임끼리 1:1로만 비교하면 된다. 정규화·각도
 * 계산·잡음보정은 배치 엔진과 완전히 같은 함수를 재사용해서 두 경로의 점수 체계가
 * 어긋나지 않게 한다.
 */
export function compareLiveFrame(
  userLandmarks: PoseLandmarkPoint[] | null,
  refLandmarks: PoseLandmarkPoint[] | null,
  mirror: boolean,
): { score: number; worstJoint: WorstJoint | null } | null {
  if (!userLandmarks || !refLandmarks) return null;

  const userAngles = computeJointAngles(normalizeLandmarks(userLandmarks));
  const refNorm = normalizeLandmarks(refLandmarks);
  const refAngles = computeJointAngles(mirror ? mirrorLandmarks(refNorm) : refNorm);

  const score = applyMatchThreshold(
    round1(frameScoreFromDistance(angleSetDistance(userAngles, refAngles))),
  );

  let worstJoint: WorstJoint | null = null;
  let worstDiff = -1;
  for (let i = 0; i < userAngles.length; i++) {
    const a = userAngles[i];
    const b = refAngles[i];
    if (a == null || b == null) continue;
    const diff = Math.abs(a - b);
    if (diff > worstDiff) {
      worstDiff = diff;
      worstJoint = { joint: JOINT_NAMES[i], avgDiffDeg: round1(diff) };
    }
  }

  return { score, worstJoint };
}

function computeWorstJoints(
  path: Array<[number, number]>,
  userAngles: Array<(number | null)[]>,
  refAngles: Array<(number | null)[]>,
  userFrames: PoseFrame[],
  range: TimeRange,
): WorstJoint[] {
  const sums = new Array(JOINT_NAMES.length).fill(0);
  const counts = new Array(JOINT_NAMES.length).fill(0);

  for (const [ui, ri] of path) {
    const t = userFrames[ui]?.timestamp;
    if (t == null || t < range.start || t > range.end) continue;
    const ua = userAngles[ui];
    const ra = refAngles[ri];
    for (let k = 0; k < JOINT_NAMES.length; k++) {
      const av = ua[k];
      const bv = ra[k];
      if (av == null || bv == null) continue;
      sums[k] += Math.abs(av - bv);
      counts[k] += 1;
    }
  }

  const withValues: WorstJoint[] = [];
  for (let k = 0; k < JOINT_NAMES.length; k++) {
    if (counts[k] > 0) withValues.push({ joint: JOINT_NAMES[k], avgDiffDeg: sums[k] / counts[k] });
  }

  return withValues
    .sort((a, b) => b.avgDiffDeg - a.avgDiffDeg)
    .slice(0, 3)
    .map((j) => ({ joint: j.joint, avgDiffDeg: round1(j.avgDiffDeg) }));
}

export interface SegmentDef {
  label: string;
  start: number;
  end: number;
}

/**
 * 두 포즈 시퀀스를 비교해 전체/구간별 일치율을 계산한다. 원본과 거울모드 두 버전을 각각
 * DTW로 정렬해보고 평균 비용이 더 낮은(=더 잘 맞는) 쪽을 채택한다.
 */
export function compareSequences(
  userFrames: PoseFrame[],
  refFrames: PoseFrame[],
  segmentDefs?: SegmentDef[],
): PoseCompareScore {
  if (userFrames.length === 0 || refFrames.length === 0) {
    throw new Error(
      "비교할 포즈 데이터가 없어요. 영상에서 사람이 감지되지 않았거나 포즈 추출이 비어있어요.",
    );
  }

  const userDS = downsampleFrames(userFrames);
  const refDS = downsampleFrames(refFrames);

  const userAngles = anglesForFrames(userDS, false);
  const refAnglesNormal = anglesForFrames(refDS, false);
  const refAnglesMirrored = anglesForFrames(refDS, true);

  const normalRun = dtwAlign(userAngles, refAnglesNormal);
  const mirrorRun = dtwAlign(userAngles, refAnglesMirrored);
  const mirrored = mirrorRun.avgCost < normalRun.avgCost;
  const chosen = mirrored ? mirrorRun : normalRun;
  const refAngles = mirrored ? refAnglesMirrored : refAnglesNormal;

  // 프레임 단위로 잡음 보정한다 — 이 프레임 하나만 놓고 봤을 때 오차가 작으면 100으로
  // 올려주고, 크면 그대로 둔다. 평균은 이 보정된 값들로 내므로 잡음은 지워지고 진짜
  // 크게 틀린 프레임은 평균을 그대로 끌어내린다. coverage는 같은 순서로 별도 보관해서
  // 구간별 lowVisibility 판정에 쓴다.
  const frameCoverage = chosen.path.map(([ui, ri]) => jointCoverage(userAngles[ui], refAngles[ri]));
  const frameScores: FrameScore[] = chosen.path.map(([ui, ri]) => ({
    t: userDS[ui].timestamp,
    score: applyMatchThreshold(
      round1(frameScoreFromDistance(angleSetDistance(userAngles[ui], refAngles[ri]))),
    ),
  }));

  const overallScore = round1(average(frameScores.map((f) => f.score)));

  const defs: SegmentDef[] =
    segmentDefs && segmentDefs.length > 0
      ? segmentDefs
      : [
          {
            label: "전체",
            start: userDS[0]?.timestamp ?? 0,
            end: userDS[userDS.length - 1]?.timestamp ?? 0,
          },
        ];

  const segments: CompareSegment[] = defs.map((seg) => {
    const inSegIdx = frameScores
      .map((f, idx) => ({ f, idx }))
      .filter(({ f }) => f.t >= seg.start && f.t <= seg.end);
    const score = round1(average(inSegIdx.map(({ f }) => f.score)));
    const avgCoverage = average(inSegIdx.map(({ idx }) => frameCoverage[idx]));
    const worstJoints = computeWorstJoints(chosen.path, userAngles, refAngles, userDS, seg);
    return {
      label: seg.label,
      start: seg.start,
      end: seg.end,
      score,
      worstJoints,
      lowVisibility: inSegIdx.length > 0 && avgCoverage < VISIBILITY_WARNING_COVERAGE,
    };
  });

  return {
    overallScore,
    mirrored,
    segments,
    frameScores,
    lowVisibility: segments.some((s) => s.lowVisibility),
  };
}

/** 두 영상에서 각자 지정한 시간 범위만 잘라내 같은 엔진으로 비교한다. */
export function compareRangePair(
  userFrames: PoseFrame[],
  refFrames: PoseFrame[],
  userRange: TimeRange,
  refRange: TimeRange,
  label?: string,
): RangePairResult {
  const userSlice = userFrames.filter((f) => f.timestamp >= userRange.start && f.timestamp <= userRange.end);
  const refSlice = refFrames.filter((f) => f.timestamp >= refRange.start && f.timestamp <= refRange.end);

  const userLen = userRange.end - userRange.start;
  const refLen = refRange.end - refRange.start;
  const lengthWarning =
    userLen > 0 && refLen > 0 && (userLen / refLen >= 2 || refLen / userLen >= 2);

  const result = compareSequences(userSlice, refSlice, [
    { label: label ?? "구간", start: userRange.start, end: userRange.end },
  ]);
  const seg = result.segments[0];

  return {
    label,
    refRange,
    userRange,
    score: seg?.score ?? 0,
    mirrored: result.mirrored,
    worstJoints: seg?.worstJoints ?? [],
    lengthWarning,
    lowVisibility: seg?.lowVisibility ?? false,
  };
}
