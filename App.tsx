import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { LayoutChangeEvent, Linking, Modal, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useVideoPlayer, VideoView } from 'expo-video';
import Svg, { Circle, Line } from 'react-native-svg';

type Page = 'home' | 'library' | 'new' | 'capture' | 'version' | 'overlay' | 'data' | 'analysis' | 'motion' | 'collab' | 'perform' | 'profile' | 'community' | 'license' | 'passport';
type License = '연습 전용' | '비상업 커버 허용' | '리믹스 허용' | '상업 이용 협의';
type MotionAsset = { uri: string; fileName: string; mimeType: string; duration?: number | null; source: 'camera' | 'library'; webFile?: File };
type Landmark = { x: number; y: number; z: number; visibility: number };
type MotionFrame = { time_ms: number; world_landmarks: Landmark[]; image_landmarks: Landmark[] };
type CollabPermission = '보기만' | '수정 제안' | '직접 수정';
type Collaborator = { id: string; user_id: string | null; name: string; role: string; counts: string; permission: CollabPermission; joined: boolean };
/** 서버(`/v1/projects`)가 내려주는 모양. 앱 메모리가 아니라 서버가 원본이다. */
type Project = {
  id: string; name: string; version: string; date: string; license: License; color: string;
  inviteCode: string; ownerId: string; ownerName: string; isOwner: boolean;
  viewerPermission: CollabPermission | null;
  sourceSha256?: string | null; videoUrl?: string | null;
  videoWidth?: number | null; videoHeight?: number | null; poseFrames?: number | null;
  workMs?: number | null;
  collaborators: Collaborator[];
};
type Me = { user_id: string; name: string };
type ContributionDay = { d: string; c: number };
type VersionEntry = {
  id: string; number: number | null; parentId: string | null; title: string; note: string;
  authorId: string; authorName: string; startMs: number | null; endMs: number | null; durationMs: number | null;
  segment: string; state: 'proposed' | 'merged' | 'declined'; date: string;
  decidedAt: string | null; decidedByName: string | null;
  sourceSha256?: string | null; poseFrames?: number | null;
  videoUrl?: string | null; videoWidth?: number | null; videoHeight?: number | null;
};
type VersionGraph = {
  main: VersionEntry[]; proposed: VersionEntry[]; declined: VersionEntry[];
  canPropose: boolean; canDecide: boolean;
  headId: string | null; headPinned: boolean; headSetByName: string | null; headSetAt: string | null;
};
type RecordFile = { key: string; kind: string; label: string; note: string; name: string; url: string; bytes: number; viewable: boolean };
type FileList = { format: string; files: RecordFile[]; source: { name: string; url: string; bytes: number } | null };
type FileView = { name: string; bytes: number; lines: string[]; shown: number; total: number; truncated: boolean; url: string };
type Community = {
  people: { user_id: string; name: string; handle: string; works: number; isMe: boolean; followers: number; following: number; isFollowing: boolean }[];
  feed: { id: string; name: string; color: string; license: License; version: string; ownerId: string; ownerName: string; people: number; poseFrames: number | null; date: string }[];
};
type Profile = {
  user_id: string; name: string; handle: string; joinedAt: string;
  isMe: boolean; followers: number; following: number; isFollowing: boolean;
  stats: { owned: number; joined: number; people: number; frames: number };
  contributions: { weeks: ContributionDay[][]; months: { label: string; week: number }[]; total: number };
  projects: { id: string; name: string; color: string; license: License; version: string; isOwner: boolean }[];
  activity: { kind: string; text: string; date: string }[];
};
type StageMode = 'original' | 'overlay' | 'skeleton';
type JobStage = 'uploading' | 'analyzing' | 'rendering' | 'encoding' | 'done' | 'error';
type JobProgress = { stage: JobStage; done: number; total: number; error?: string };

const MEDIAPIPE_API_URL = process.env.EXPO_PUBLIC_MEDIAPIPE_API_URL;

// ChoreoHub is a living archive, not a developer dashboard.  The palette keeps
// the page tactile and editorial while the blue carries the provenance signal.
const PURPLE = '#7FA5FF';
const PERMISSIONS: CollabPermission[] = ['보기만', '수정 제안', '직접 수정'];
const permissionCopy: Record<CollabPermission, string> = {
  '보기만': '영상과 포즈 데이터를 열어볼 수 있어요.',
  '수정 제안': '수정안을 올리면 원작자가 확인 후 반영해요.',
  '직접 수정': '새 버전을 바로 추가할 수 있어요.',
};


/* ══════════ 서버 통신 ══════════ */

const API = MEDIAPIPE_API_URL ?? '';

async function api(path: string, init?: { method?: string; body?: any }) {
  const response = await fetch(`${API}${path}`, {
    method: init?.method ?? 'GET',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error: any = new Error(data?.detail ?? '요청이 실패했어요.');
    error.status = response.status;
    throw error;
  }
  return data;
}

// 표시 이름만으로 신원을 만든다. 웹은 localStorage 에 남겨 새로고침해도 같은 사람으로
// 돌아온다. 네이티브는 저장소 패키지가 없어 세션 동안만 유지된다.
const ME_KEY = 'choreohub.me';
const loadMe = (): Me | null => {
  try { const raw = globalThis.localStorage?.getItem(ME_KEY); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
};
const saveMe = (me: Me | null) => {
  try { me ? globalThis.localStorage?.setItem(ME_KEY, JSON.stringify(me)) : globalThis.localStorage?.removeItem(ME_KEY); }
  catch {}
};

// 기여자마다 색을 하나씩 준다. 첫 등장 순서로 배정해 화면을 다시 열어도 같은 색이 나온다.
const CREDIT_COLORS = ['#7FA5FF', '#4FC7A2', '#FF8B77', '#E0AE3C', '#B490E8', '#4BC3D9', '#F084B8'];

/** 밀리초 → `0:08`. 구간은 사람이 읽는 분:초가 기본 표기다. */
const fmtMs = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** `0:08` · `08` · `1:2` 를 모두 받아 밀리초로. 형식이 아니면 null. */
const parseClock = (text: string): number | null => {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(':');
  if (parts.length > 2 || parts.some(part => part !== '' && !/^\d+$/.test(part))) return null;
  const minutes = parts.length === 2 ? Number(parts[0] || 0) : 0;
  const seconds = Number(parts[parts.length - 1] || 0);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || seconds > 59) return null;
  return (minutes * 60 + seconds) * 1000;
};

/** 잡 시작 응답에서 영상 길이(ms)를 구한다. 작품 타임라인의 기준이 된다. */
const durationOf = (started: { frame_count?: number; fps?: number }) =>
  started.frame_count && started.fps ? Math.round((started.frame_count / started.fps) * 1000) : null;

/** 길이를 사람 말로. 지분 표기가 타임스탬프처럼 읽히지 않게 한다. */
const fmtSpan = (seconds: number) => seconds >= 60
  ? `${Math.floor(seconds / 60)}분 ${seconds % 60}초`
  : `${seconds}초`;

const initialsOf = (name: string) => { const text = name.trim(); return /[a-zA-Z]/.test(text[0] ?? '') ? text.slice(0, 2).toUpperCase() : text.slice(0, 1); };
const makeInviteCode = () => `CHO-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const licenseColor: Record<License, string> = { '연습 전용': '#93A2AE', '비상업 커버 허용': '#7FA5FF', '리믹스 허용': '#4FC7A2', '상업 이용 협의': '#E0A85C' };

// 뼈대를 좌/우로 나눠 칠하면 몸이 어느 쪽으로 도는지 한눈에 읽힌다.
// 초록 = 무용수 기준 왼쪽, 노랑 = 오른쪽, 파랑 = 몸통. 얼굴은 그리지 않는다.
const BONE = { torso: PURPLE, left: '#4FC7A2', right: '#E0AE3C' } as const;
type BoneGroup = keyof typeof BONE;
const CONNECTIONS: [number, number, BoneGroup][] = [
  [11, 12, 'torso'], [11, 23, 'torso'], [12, 24, 'torso'], [23, 24, 'torso'],
  [11, 13, 'left'], [13, 15, 'left'], [15, 17, 'left'], [15, 19, 'left'], [15, 21, 'left'], [17, 19, 'left'],
  [12, 14, 'right'], [14, 16, 'right'], [16, 18, 'right'], [16, 20, 'right'], [16, 22, 'right'], [18, 20, 'right'],
  [23, 25, 'left'], [25, 27, 'left'], [27, 29, 'left'], [27, 31, 'left'], [29, 31, 'left'],
  [24, 26, 'right'], [26, 28, 'right'], [28, 30, 'right'], [28, 32, 'right'], [30, 32, 'right'],
];

/** 재생 시각(ms) 이하의 마지막 프레임. 포즈가 잡히지 않은 구간은 비어 있으므로 시간으로 찾는다. */
function frameAt(frames: MotionFrame[], timeMs: number) {
  let low = 0, high = frames.length - 1, found = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (frames[middle].time_ms <= timeMs) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  return found;
}

/**
 * 영상 위에 실제 관절을 그린다.
 *
 * contentFit="contain" 이라 영상은 stage 안에서 레터박스된다. 좌표를 stage 전체에
 * 매핑하면 관절이 몸에서 밀리므로, 영상이 실제로 그려지는 상자를 계산해 그 안에 찍는다.
 */
function PoseOverlay({ landmarks, stage, video }: { landmarks?: Landmark[]; stage: { width: number; height: number }; video: { width: number; height: number } }) {
  if (!landmarks?.length || !stage.width || !stage.height || !video.width || !video.height) return null;
  const scale = Math.min(stage.width / video.width, stage.height / video.height);
  const boxWidth = video.width * scale, boxHeight = video.height * scale;
  const offsetX = (stage.width - boxWidth) / 2, offsetY = (stage.height - boxHeight) / 2;
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const toX = (point: Landmark) => offsetX + clamp(point.x) * boxWidth;
  const toY = (point: Landmark) => offsetY + clamp(point.y) * boxHeight;
  const stroke = Math.max(2, Math.round(boxWidth / 105));
  return (
    <Svg style={StyleSheet.absoluteFill} width={stage.width} height={stage.height} pointerEvents="none">
      {CONNECTIONS.map(([from, to, group], index) => {
        const start = landmarks[from], end = landmarks[to];
        if (!start || !end) return null;
        return <Line key={index} x1={toX(start)} y1={toY(start)} x2={toX(end)} y2={toY(end)} stroke={BONE[group]} strokeWidth={stroke} strokeLinecap="round" opacity={0.4 + 0.6 * Math.min(start.visibility, end.visibility)} />;
      })}
      {landmarks.map((point, index) => index < 11 ? null : (
        <Circle key={index} cx={toX(point)} cy={toY(point)} r={stroke * 0.8} fill={index % 2 === 1 ? BONE.left : BONE.right} opacity={0.4 + 0.6 * point.visibility} />
      ))}
    </Svg>
  );
}

/** 크레딧 트리의 한 줄. 연결선은 고정폭 글자로 그려 구조가 그대로 읽히게 한다. */
type CreditNode = { label: string; sub?: string; tone?: 'accent' | 'warn' | 'muted'; children?: CreditNode[] };

function flattenTree(nodes: CreditNode[], prefix = '', keyBase = ''):
    { key: string; prefix: string; cont: string; node: CreditNode }[] {
  return nodes.flatMap((node, index) => {
    const last = index === nodes.length - 1;
    const key = `${keyBase}.${index}`;
    const below = prefix + (last ? '   ' : '│  ');
    // cont 는 부제 줄에도 세로선을 이어 주기 위한 것 — 없으면 트리가 끊겨 보인다
    const row = { key, prefix: prefix + (last ? '└─ ' : '├─ '), cont: below, node };
    return [row, ...flattenTree(node.children ?? [], below, key)];
  });
}

function MotionMark({ color = PURPLE, large = false }: { color?: string; large?: boolean }) {
  const size = large ? 62 : 42;
  return <View style={[s.mark, { width: size, height: size, backgroundColor: `${color}25` }]}>{[.45,.72,.96,.6].map((h, i) => <View key={i} style={{ width: large ? 5 : 4, height: size * h, backgroundColor: color, borderRadius: 4 }} />)}</View>;
}
// 스타일 `s` 는 파일 아래쪽에서 선언되므로 상수가 아니라 컴포넌트여야 한다 (모듈 로드 시점 TDZ 회피)
const EmptyStage = () => <View style={s.videoPlaceholder}><Text style={s.videoPlaceholderIcon}>◉</Text><Text style={s.videoPlaceholderTitle}>업로드된 원본 영상이 여기에 표시됩니다</Text><Text style={s.videoPlaceholderCopy}>새 안무를 게시하면 이 화면에서 바로 재생할 수 있어요.</Text></View>;

/**
 * 원본 영상과 관절 오버레이를 함께 재생한다.
 *
 * 서버가 만든 `preview_overlay.mp4` 를 그대로 트는 대신 좌표만 받아 매 프레임 직접
 * 그린다. 모드 전환이 즉각적이고, 원본과 프레임이 정확히 맞으며, 두 번째 영상 파일을
 * 기다릴 필요가 없다.
 *
 * `positionRef` 는 재생 위치를 화면 밖에 보관한다. 페이지 컴포넌트가 App 리렌더마다
 * 새로 만들어져 이 컴포넌트가 remount 되는데, 그때 영상이 처음으로 되감기는 걸 막는다.
 */
function MotionPlayer({ uri, frames = [], video, mode = 'overlay', positionRef, frameRef }: {
  uri?: string;
  frames?: MotionFrame[];
  video?: { width: number; height: number };
  mode?: StageMode;
  positionRef?: React.MutableRefObject<number>;
  frameRef?: React.MutableRefObject<number>;
}) {
  const player = useVideoPlayer(uri ?? null, instance => { instance.loop = true; });
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [index, setIndex] = useState(frameRef?.current ?? 0);
  const indexRef = useRef(index);

  // remount 되었거나 소스가 바뀌었으면 직전 재생 위치에서 이어 튼다.
  // 한 틱 미루는 이유: 업로드 직후 로컬 URI 가 서버 URI 로 교체되는데, 바로 play() 하면
  // 새 load 요청이 이전 play() 를 잘라 "play() request was interrupted" 가 뜬다.
  useEffect(() => {
    if (!uri) return;
    let alive = true;
    const start = setTimeout(() => {
      if (!alive) return;
      if (positionRef && positionRef.current > 0) player.currentTime = positionRef.current;
      player.play();
    }, 120);
    return () => { alive = false; clearTimeout(start); };
  }, [uri, player]);

  // 재생 시각 → 프레임. 프레임 번호가 바뀔 때만 setState 해서 매 tick 리렌더를 피한다.
  useEffect(() => {
    if (!uri || !frames.length) return;
    let handle = 0;
    const tick = () => {
      handle = requestAnimationFrame(tick);
      const seconds = player.currentTime ?? 0;
      if (positionRef) positionRef.current = seconds;
      const next = frameAt(frames, seconds * 1000);
      if (next !== indexRef.current) {
        indexRef.current = next;
        if (frameRef) frameRef.current = next;
        setIndex(next);
      }
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [uri, frames, player]);

  if (!uri) return <EmptyStage />;

  const landmarks = frames[Math.min(index, frames.length - 1)]?.image_landmarks;
  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setStage(current => current.width === width && current.height === height ? current : { width, height });
  };

  return (
    <View style={s.videoStage} onLayout={onLayout}>
      <VideoView style={s.video} player={player} nativeControls contentFit="contain" fullscreenOptions={{ enable: true }} />
      {mode === 'skeleton' && <View pointerEvents="none" style={s.skeletonBackdrop} />}
      {mode !== 'original' && video ? <PoseOverlay landmarks={landmarks} stage={stage} video={video} /> : null}
      {mode !== 'original' && (
        <View style={s.overlayCaption} pointerEvents="none">
          <Text style={s.overlayCaptionText}>{frames.length ? `f${index} · ${landmarks?.length ?? 0} LANDMARKS` : '포즈 데이터 없음'}</Text>
        </View>
      )}
    </View>
  );
}

function Pill({ name }: { name: License | '원작 연결됨' }) { const color = name === '원작 연결됨' ? '#4FC7A2' : licenseColor[name]; return <View style={[s.pill, { backgroundColor: `${color}20` }]}><Text style={[s.pillText, { color }]}>{name}</Text></View>; }
function Header({ title, back }: { title: string; back?: () => void }) { return <View style={s.header}>{back ? <Pressable onPress={back}><Text style={s.back}>‹</Text></Pressable> : <View style={s.headerGap} />}<Text style={s.headerTitle}>{title}</Text><Text style={s.more}>•••</Text></View>; }
function Bottom({ page, go, plus }: { page: Page; go: (p: Page) => void; plus: () => void }) {
  const items: [string,string,Page|undefined][] = [['⌂','홈','home'],['▱','내 작업','library'],['＋','',undefined],['▥','탐색','community'],['♙','프로필','profile']];
  return <View style={s.bottom}>{items.map(([icon,label,target],i) => <Pressable key={i} style={s.nav} onPress={() => target ? go(target) : plus()}><View style={i === 2 ? s.navPlus : undefined}><Text style={[s.navIcon, target === page && s.active, i === 2 && s.navPlusIcon]}>{icon}</Text></View>{label ? <Text style={[s.navLabel, target === page && s.active]}>{label}</Text> : null}</Pressable>)}</View>;
}

export default function App() {
  const [page, setPage] = useState<Page>('home');
  const [me, setMe] = useState<Me | null>(loadMe);
  const [signInName, setSignInName] = useState('');
  const [remoteProjects, setRemoteProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [serverError, setServerError] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [busy, setBusy] = useState(false);
  // react-native-web 의 Alert 는 `static alert() {}` — 웹에서 아무 일도 하지 않는다.
  // 그래서 검증 실패나 오류 안내가 전부 사라지고 "버튼이 안 눌린다"로 보였다.
  const [toast, setToast] = useState<{ title: string; body?: string; kind: 'error' | 'ok' } | null>(null);
  const notify = (title: string, body?: string, kind: 'error' | 'ok' = 'error') => setToast({ title, body, kind });
  const [profile, setProfile] = useState<Profile | null>(null);
  const graphRef = useRef<ScrollView>(null);
  const [viewingUserId, setViewingUserId] = useState<string | null>(null);
  const [community, setCommunity] = useState<Community | null>(null);
  const [fileList, setFileList] = useState<FileList | null>(null);
  const [fileView, setFileView] = useState<FileView | null>(null);
  const [versions, setVersions] = useState<VersionGraph | null>(null);
  const [proposeOpen, setProposeOpen] = useState(false);
  // 특정 버전의 클립만 볼 때 — null 이면 작품의 현재 영상을 본다
  const [viewingVersion, setViewingVersion] = useState<VersionEntry | null>(null);
  const [versionFrames, setVersionFrames] = useState<{ key: string; frames: MotionFrame[] }>({ key: '', frames: [] });
  const [editOpen, setEditOpen] = useState(false);
  const [editDraft, setEditDraft] = useState<{ name: string; license: License }>({ name: '', license: '리믹스 허용' });
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [proposeDraft, setProposeDraft] = useState({ title: '', note: '', from: '', to: '' });
  const [proposeAsset, setProposeAsset] = useState<MotionAsset | null>(null);
  const [proposeJob, setProposeJob] = useState<JobProgress | null>(null);
  const [proposeMotion, setProposeMotion] = useState<Record<string, any> | null>(null);
  const [proposePending, setProposePending] = useState(false);
  const [license, setLicense] = useState<License>('리믹스 허용');
  const [modal, setModal] = useState(false); const [name, setName] = useState(''); const [filter, setFilter] = useState('전체');
  const [asset, setAsset] = useState<MotionAsset | null>(null); const [job, setJob] = useState<JobProgress | null>(null); const [pendingPublish, setPendingPublish] = useState(false); const [poseFrames, setPoseFrames] = useState(0); const [motionFrames, setMotionFrames] = useState<MotionFrame[]>([]); const [previewUrls, setPreviewUrls] = useState<{ overlay?: string; skeleton?: string }>({}); const [overlayIndex, setOverlayIndex] = useState(0); const [recording, setRecording] = useState(false); const cameraRef = useRef<CameraView>(null); const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  // 오버레이 화면 상태. 재생 위치와 현재 프레임은 ref 에 둔다 — 매 프레임 setState 하면
  // 페이지 컴포넌트가 App 리렌더마다 새로 만들어지는 구조 탓에 영상이 계속 끊긴다.
  const [stageMode, setStageMode] = useState<StageMode>('overlay');
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
  const [motionRef, setMotionRef] = useState<Record<string, any> | null>(null);
  // 캐시 키에 영상 해시를 넣는다. 프로젝트 id 만으로 묶으면 main 에 새 버전이 반영돼
  // 영상이 바뀌어도 예전 스켈레톤을 계속 그린다 (길이가 다르면 눈에 크게 튄다).
  const [projectFrames, setProjectFrames] = useState<{ key: string; frames: MotionFrame[] }>({ key: '', frames: [] });
  const playbackRef = useRef(0); const liveFrameRef = useRef(0);
  const go = (p: Page) => setPage(p); const open = (p: Project) => { setSelectedId(p.id); setLicense(p.license); go('version'); };
  const stageLabel = (stage: JobStage, done: number, total: number) => stage === 'uploading' ? '영상을 올리는 중이에요'
    : stage === 'analyzing' ? `관절을 읽는 중이에요 · ${done}/${total || '?'} 프레임`
    : stage === 'rendering' ? '기록한 관절을 정리하는 중이에요'
    : stage === 'encoding' ? '미리보기 영상을 만드는 중이에요' : '포즈 데이터를 모두 기록했어요';

  const jobPercent = (job: JobProgress) => job.stage === 'uploading' ? 4 : job.stage === 'rendering' ? 92
    : job.stage === 'encoding' ? 96 : job.stage === 'done' ? 100
    : job.total ? Math.max(6, Math.min(90, (job.done / job.total) * 90)) : 8;

  /**
   * 영상을 올려 분석 잡을 시작하고 진행 상황을 콜백으로 넘긴다.
   *
   * 원작 게시와 수정 제안이 같은 파이프라인을 쓴다 — 구현이 둘로 갈라지면 한쪽만 고쳐지는
   * 일이 생긴다. 상태는 호출한 쪽이 각자 들고 있어서 두 흐름이 서로를 건드리지 않는다.
   */
  const uploadForAnalysis = async (asset: MotionAsset, onStage: (job: JobProgress) => void,
                                   onStarted: (started: any) => void, onDone: (result: any) => void) => {
    onStage({ stage: 'uploading', done: 0, total: 0 });
    if (!MEDIAPIPE_API_URL) {
      onStage({ stage: 'error', done: 0, total: 0, error: '분석 서버 주소가 설정되지 않았어요.' });
      return;
    }
    let started: any;
    try {
      const data = new FormData();
      if (typeof window !== 'undefined') {
        const file = (asset.webFile ?? await fetch(asset.uri).then(response => response.blob())) as Blob;
        data.append('video', file, asset.fileName);
      } else data.append('video', { uri: asset.uri, name: asset.fileName, type: asset.mimeType } as any);
      const response = await fetch(`${MEDIAPIPE_API_URL}/v1/jobs`, { method: 'POST', body: data });
      if (!response.ok) throw new Error('업로드 실패');
      started = await response.json();
    } catch {
      onStage({ stage: 'error', done: 0, total: 0, error: '분석 서버에 연결하지 못했어요. 네트워크와 서버 상태를 확인해 주세요.' });
      return;
    }
    onStarted(started);
    onStage({ stage: 'analyzing', done: 0, total: started.frame_count ?? 0 });
    for (;;) {
      await new Promise(done => setTimeout(done, 600));
      let status: any;
      try { status = await (await fetch(`${MEDIAPIPE_API_URL}/v1/jobs/${started.job_id}`)).json(); }
      catch { onStage({ stage: 'error', done: 0, total: 0, error: '진행 상황을 받아오지 못했어요.' }); return; }
      if (status.state === 'error') { onStage({ stage: 'error', done: 0, total: 0, error: status.error ?? '분석에 실패했어요.' }); return; }
      if (status.state === 'done') {
        const result = status.result ?? {};
        onDone(result);
        onStage({ stage: 'done', done: result.frame_count ?? 0, total: result.frame_count ?? 0 });
        return;
      }
      onStage({ stage: (status.stage ?? 'analyzing') as JobStage, done: status.done ?? 0, total: status.total ?? 0 });
    }
  };

  const processMotion = async (nextAsset: MotionAsset) => {
    setAsset(nextAsset); setMotionFrames([]); setPoseFrames(0); setPreviewUrls({});
    setVideoSize(null); setMotionRef(null); setPendingPublish(false);
    await uploadForAnalysis(nextAsset, setJob,
      started => {
        // 분석을 기다리지 않고 영상부터 띄운다 — 그동안 제목과 라이선스를 입력할 수 있다
        if (started.video_url) {
          const hosted = new URL(started.video_url, API).toString();
          setAsset(current => current ? { ...current, uri: hosted } : current);
        }
        if (started.width && started.height) setVideoSize({ width: started.width, height: started.height });
        setMotionRef({ source_sha256: started.source_sha256, video_url: started.video_url,
                       width: started.width, height: started.height, frame_count: started.frame_count,
                       fps: started.fps, duration_ms: durationOf(started) });
      },
      result => {
        setPreviewUrls({
          overlay: result.preview_overlay_url ? new URL(result.preview_overlay_url, API).toString() : undefined,
          skeleton: result.preview_3d_skeleton_url ? new URL(result.preview_3d_skeleton_url, API).toString() : undefined });
        setMotionFrames(result.frames ?? []); setPoseFrames(result.frame_count ?? 0);
        if (result.width && result.height) setVideoSize({ width: result.width, height: result.height });
        setMotionRef(current => ({ ...(current ?? {}), frame_count: result.frame_count ?? 0 }));
      });
  };

  /* ── 제안에 영상 첨부 ── */

  const attachProposalVideo = async (nextAsset: MotionAsset) => {
    setProposeAsset(nextAsset); setProposeMotion(null);
    await uploadForAnalysis(nextAsset, setProposeJob,
      started => setProposeMotion({ source_sha256: started.source_sha256, video_url: started.video_url,
                                    width: started.width, height: started.height, frame_count: started.frame_count,
                                    fps: started.fps, duration_ms: durationOf(started) }),
      result => setProposeMotion(current => ({ ...(current ?? {}), frame_count: result.frame_count ?? 0 })));
  };

  const chooseProposalVideo = async () => {
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['videos'], allowsEditing: false });
    if (picked.canceled) return;
    const file = picked.assets[0];
    await attachProposalVideo({ uri: file.uri, fileName: file.fileName ?? `segment-${Date.now()}.mp4`,
      mimeType: file.mimeType ?? 'video/mp4', duration: file.duration, source: 'library', webFile: file.file });
  };

  const clearProposalVideo = () => { setProposeAsset(null); setProposeJob(null); setProposeMotion(null); };

  const chooseVideo = async () => { const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['videos'], allowsEditing: false }); if (!result.canceled) { const file = result.assets[0]; await processMotion({ uri: file.uri, fileName: file.fileName ?? `choreo-${Date.now()}.mp4`, mimeType: file.mimeType ?? 'video/mp4', duration: file.duration, source: 'library', webFile: file.file }); } };
  const toggleRecording = async () => { if (!cameraPermission?.granted) { const permission = await requestCameraPermission(); if (!permission.granted) return; } if (!cameraRef.current) return; if (recording) { cameraRef.current.stopRecording(); return; } setRecording(true); try { const video = await cameraRef.current.recordAsync({ maxDuration: 60 }); if (video?.uri) await processMotion({ uri: video.uri, fileName: `choreo-${Date.now()}.mp4`, mimeType: 'video/mp4', source: 'camera' }); } finally { setRecording(false); } };
  /* ── 서버 상태 ── */

  const selected: Project | null = remoteProjects.find(item => item.id === selectedId) ?? remoteProjects[0] ?? null;
  const collaborators = selected?.collaborators ?? [];
  const canEdit = !!selected && (selected.isOwner || selected.viewerPermission === '직접 수정');

  const refresh = async (userId = me?.user_id) => {
    if (!userId) return;
    try {
      setRemoteProjects(await api(`/v1/projects?user_id=${userId}`));
      setServerError('');
    } catch (error: any) {
      // 서버 데이터가 초기화되면 이 기기에 남은 user_id 는 더 이상 존재하지 않는다.
      // 그대로 두면 매번 401 만 뜨므로 신원을 지우고 다시 이름을 받는다.
      if (error?.status === 401) { saveMe(null); setMe(null); setRemoteProjects([]); setSelectedId(null); return; }
      setServerError(error?.message ?? '작업 목록을 받아오지 못했어요.');
    }
  };

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => { if (me) refresh(me.user_id); }, [me?.user_id]);

  const viewedUserId = viewingUserId ?? me?.user_id ?? null;

  useEffect(() => {
    if (!me || page !== 'profile' || !viewedUserId) return;
    setProfile(null);
    api(`/v1/users/${viewedUserId}/profile?viewer_id=${me.user_id}`).then(setProfile).catch(() => setProfile(null));
  }, [me?.user_id, viewedUserId, page, remoteProjects.length]);

  const loadVersions = async (projectId = selected?.id) => {
    if (!projectId || !me) return;
    try { setVersions(await api(`/v1/projects/${projectId}/versions?user_id=${me.user_id}`)); }
    catch { setVersions(null); }
  };

  useEffect(() => {
    if (!selected || !me || !['version', 'passport'].includes(page)) return;
    loadVersions(selected.id);
  }, [selected?.id, page, me?.user_id]);

  const proposeBusy = !!proposeJob && proposeJob.stage !== 'done' && proposeJob.stage !== 'error';

  /** 게시 후에도 원작자(와 '직접 수정' 권한자)가 제목·공유 범위를 고칠 수 있게 한다. */
  const openEditPost = () => {
    if (!selected) return;
    setEditDraft({ name: selected.name, license: selected.license });
    setDeleteConfirm('');
    setEditOpen(true);
  };

  /** 작업 삭제. 되돌릴 수 없으므로 작업 이름을 정확히 입력해야 실행된다. */
  const deletePost = async () => {
    if (!selected || !me) return;
    if (deleteConfirm.trim() !== selected.name) {
      return notify('이름이 일치하지 않아요', `삭제하려면 “${selected.name}” 을 그대로 입력해 주세요.`);
    }
    setBusy(true);
    try {
      const gone = await api(`/v1/projects/${selected.id}?user_id=${me.user_id}`, { method: 'DELETE' });
      setEditOpen(false); setDeleteConfirm('');
      setSelectedId(null); setVersions(null); setViewingVersion(null);
      setProjectFrames({ key: '', frames: [] });
      await refresh();
      go('library');
      notify('작업을 삭제했어요', `${gone.name} · 버전 ${gone.versions}개와 참여자 ${gone.collaborators}명 기록이 함께 삭제됐습니다.`, 'ok');
    } catch (error: any) { notify('삭제하지 못했어요', error?.message ?? '다시 시도해 주세요.'); }
    finally { setBusy(false); }
  };

  const saveEditPost = async () => {
    if (!selected || !me) return;
    const wanted = editDraft.name.trim();
    if (!wanted) return notify('제목이 필요해요', '작업 이름을 비워 둘 수 없어요.');
    setBusy(true);
    try {
      await api(`/v1/projects/${selected.id}`, { method: 'PATCH', body: {
        user_id: me.user_id, name: wanted, license: editDraft.license } });
      await refresh();
      setEditOpen(false);
      notify('수정했어요', `${wanted} · ${editDraft.license}`, 'ok');
    } catch (error: any) { notify('수정하지 못했어요', error?.message ?? '다시 시도해 주세요.'); }
    finally { setBusy(false); }
  };

  const submitProposal = async () => {
    if (!selected || !me) return;
    // 분석 중이면 기다리게 하지 않고 예약한다 — 원작 게시와 같은 방식
    if (proposeBusy) { setProposePending(current => !current); return; }
    const hasFrom = !!proposeDraft.from.trim();
    const hasTo = !!proposeDraft.to.trim();
    // 구간은 필수다 — 구간이 없으면 어느 부분의 크레딧인지 정할 수 없다
    if (!hasFrom || !hasTo) return notify('고친 구간이 필요해요', '어디를 고쳤는지 시작·끝 시간을 적어 주세요.');
    const from = parseClock(proposeDraft.from);
    const to = parseClock(proposeDraft.to);
    if (from === null || to === null)
      return notify('시간 형식을 확인해 주세요', '0:08 처럼 분:초 로 적어 주세요. 초만 적어도 됩니다.');
    if (from !== null && to !== null && to <= from)
      return notify('구간을 확인해 주세요', '끝 시간이 시작 시간보다 뒤여야 해요.');
    const limit = selected.workMs ?? 0;
    // 작품 길이를 넘는 구간은 허용한다 — 반영되면 작품이 그만큼 길어진다.
    // 오타(예: 90:00)만 막는다.
    if (to !== null && limit && to > limit + 600000)
      return notify('시간을 확인해 주세요', `작품(${fmtMs(limit)})을 10분 넘게 늘릴 수는 없어요.`);
    if (!proposeDraft.title.trim()) return notify('제목이 필요해요', '무엇을 고쳤는지 한 줄로 적어 주세요.');
    setBusy(true);
    try {
      const result = await api(`/v1/projects/${selected.id}/versions`, { method: 'POST', body: {
        user_id: me.user_id, title: proposeDraft.title, note: proposeDraft.note,
        start_ms: from, end_ms: to, motion: proposeMotion,
      } });
      setVersions(result); setProposeOpen(false);
      setProposeDraft({ title: '', note: '', from: '', to: '' });
      clearProposalVideo(); setProposePending(false);
      await refresh();
      const grew = result.extended && result.workMs
        ? ` 작품이 ${fmtMs(result.workMsBefore)} → ${fmtMs(result.workMs)} 로 길어졌습니다.` : '';
      notify(result.merged ? 'main 에 반영했어요' : '제안을 보냈어요',
        (result.merged ? '권한이 있어 바로 main 에 올라갔습니다.' : '원작자가 확인하면 main 에 반영됩니다.') + grew, 'ok');
    } catch (error: any) { notify('보내지 못했어요', error?.message ?? '다시 시도해 주세요.'); }
    finally { setBusy(false); }
  };

  /** 현재 버전(HEAD)을 지정한다. 이력은 그대로 두고 가리키는 곳만 바꾼다. */
  /** 그 버전에 첨부된 클립만 재생한다. 작품 전체 영상과 구분해서 본다. */
  const openVersionClip = (version: VersionEntry) => {
    if (!version.sourceSha256) return notify('이 버전에는 영상이 없어요', '메모와 구간만 기록된 버전입니다.');
    setViewingVersion(version);
    playbackRef.current = 0; liveFrameRef.current = 0;
    setStageMode(stageMode === 'original' ? 'overlay' : stageMode);
    go('overlay');
  };

  const closeVersionClip = () => {
    setViewingVersion(null);
    playbackRef.current = 0; liveFrameRef.current = 0;
  };

  useEffect(() => {
    if (!selected || !viewingVersion || page !== 'overlay') return;
    if (versionFrames.key === viewingVersion.id) return;
    api(`/v1/projects/${selected.id}/versions/${viewingVersion.id}/frames`)
      .then(data => setVersionFrames({ key: viewingVersion.id, frames: data?.frames ?? [] }))
      .catch(() => setVersionFrames({ key: viewingVersion.id, frames: [] }));
  }, [selected?.id, viewingVersion?.id, page]);

  const setHead = async (version: VersionEntry) => {
    if (!selected || !me) return;
    setBusy(true);
    try {
      setVersions(await api(`/v1/projects/${selected.id}/versions/${version.id}/head`, {
        method: 'POST', body: { user_id: me.user_id } }));
      await refresh();
      setProjectFrames({ key: '', frames: [] });   // 영상이 바뀌었으니 관절도 다시 받는다
      playbackRef.current = 0; liveFrameRef.current = 0;
      notify('현재 버전을 바꿨어요', `v${version.number} · ${version.segment}`, 'ok');
    } catch (error: any) { notify('바꾸지 못했어요', error?.message ?? '다시 시도해 주세요.'); }
    finally { setBusy(false); }
  };

  const decideProposal = async (version: VersionEntry, accept: boolean) => {
    if (!selected || !me) return;
    setBusy(true);
    try {
      setVersions(await api(`/v1/projects/${selected.id}/versions/${version.id}/decide`, {
        method: 'POST', body: { user_id: me.user_id, accept } }));
      await refresh();
    } catch (error: any) { notify('처리하지 못했어요', error?.message ?? '다시 시도해 주세요.'); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (!selected || page !== 'data') return;
    setFileView(null);
    api(`/v1/projects/${selected.id}/files`).then(setFileList).catch(() => setFileList(null));
  }, [selected?.id, page]);

  const openFileView = (file: RecordFile) => {
    if (!selected) return;
    setFileView(null);
    api(`/v1/projects/${selected.id}/files/${file.key}/preview`).then(setFileView)
      .catch((error: any) => notify('열지 못했어요', error?.message ?? '다시 시도해 주세요.'));
  };

  /** 웹에서는 실제 내려받기가 되도록 앵커를 쓰고, 네이티브는 기본 앱으로 넘긴다. */
  const downloadFile = (url: string, name: string) => {
    const full = new URL(url, API).toString();
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const anchor = document.createElement('a');
      anchor.href = full; anchor.download = name; anchor.rel = 'noopener';
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      return;
    }
    Linking.openURL(full).catch(() => notify('열지 못했어요', full));
  };

  const prettyBytes = (bytes: number) => bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB`
    : bytes >= 1e3 ? `${Math.round(bytes / 1e3)} KB` : `${bytes} B`;

  useEffect(() => {
    if (!me || page !== 'community') return;
    api(`/v1/community?viewer_id=${me.user_id}`).then(setCommunity).catch(() => setCommunity(null));
  }, [me?.user_id, page]);

  /** 하단 탭 이동. '프로필' 탭은 항상 내 프로필이어야 하므로 보고 있던 남의 프로필을 푼다. */
  const navTo = (target: Page) => { if (target === 'profile') setViewingUserId(null); go(target); };

  /** 다른 사람의 프로필로 이동. 참여하지 않은(계정 없는) 초대 이름은 열 수 없다. */
  const openProfile = (userId?: string | null) => {
    if (!userId) return;
    setViewingUserId(userId === me?.user_id ? null : userId);
    go('profile');
  };

  const toggleFollow = async (userId: string, following: boolean) => {
    if (!me) return;
    try {
      if (following) await api(`/v1/users/${userId}/follow?viewer_id=${me.user_id}`, { method: 'DELETE' });
      else await api(`/v1/users/${userId}/follow`, { method: 'POST', body: { viewer_id: me.user_id } });
      if (page === 'profile') api(`/v1/users/${userId}/profile?viewer_id=${me.user_id}`).then(setProfile).catch(() => {});
      if (page === 'community') api(`/v1/community?viewer_id=${me.user_id}`).then(setCommunity).catch(() => {});
    } catch { notify('처리하지 못했어요', '잠시 후 다시 시도해 주세요.'); }
  };

  // 다른 사람이 초대하거나 수정한 내용을 화면에 반영한다. 협업 관련 화면에서만 돈다.
  useEffect(() => {
    if (!me || !['library', 'version', 'collab', 'home'].includes(page)) return;
    const timer = setInterval(() => refresh(me.user_id), 4000);
    return () => clearInterval(timer);
  }, [me?.user_id, page]);

  const signIn = async () => {
    const wanted = signInName.trim();
    if (!wanted) return notify('이름이 필요해요', '다른 참여자에게 보일 이름을 적어 주세요.');
    setBusy(true);
    try {
      const created: Me = await api('/v1/users', { method: 'POST', body: { name: wanted } });
      saveMe(created); setMe(created); setSignInName(''); await refresh(created.user_id); go('home');
    } catch (error: any) { setServerError(error?.message ?? '서버에 연결하지 못했어요.'); }
    finally { setBusy(false); }
  };

  const signOut = () => { saveMe(null); setMe(null); setRemoteProjects([]); setSelectedId(null); go('home'); };

  const joinByCode = async () => {
    const code = joinCode.trim().toUpperCase();
    if (!code || !me) return;
    setBusy(true);
    try {
      const project: Project = await api(`/v1/invites/${encodeURIComponent(code)}/join`, { method: 'POST', body: { user_id: me.user_id } });
      setJoinCode(''); await refresh(); setSelectedId(project.id); setLicense(project.license); go('version');
    } catch (error: any) { notify('참여하지 못했어요', error?.message ?? '초대 코드를 확인해 주세요.'); }
    finally { setBusy(false); }
  };

  /* ── 공동 작업자 ── */

  const [collabEditing, setCollabEditing] = useState<Collaborator | 'new' | null>(null);
  const [collabDraft, setCollabDraft] = useState<{ name: string; role: string; counts: string; permission: CollabPermission }>({ name: '', role: '', counts: '', permission: '수정 제안' });

  const openCollabSheet = (target: Collaborator | 'new') => {
    setCollabEditing(target);
    setCollabDraft(target === 'new' ? { name: '', role: '', counts: '', permission: '수정 제안' }
      : { name: target.name, role: target.role, counts: target.counts, permission: target.permission });
  };

  const saveCollaborator = async () => {
    if (!selected || !me) return;
    const wanted = collabDraft.name.trim();
    if (!wanted) return notify('이름이 필요해요', '함께 작업할 사람의 이름이나 활동명을 적어 주세요.');
    const body = { user_id: me.user_id, name: wanted, role: collabDraft.role, counts: collabDraft.counts, permission: collabDraft.permission };
    setBusy(true);
    try {
      const path = collabEditing && collabEditing !== 'new'
        ? `/v1/projects/${selected.id}/collaborators/${collabEditing.id}`
        : `/v1/projects/${selected.id}/collaborators`;
      await api(path, { method: collabEditing && collabEditing !== 'new' ? 'PATCH' : 'POST', body });
      await refresh(); setCollabEditing(null);
    } catch (error: any) { notify('저장하지 못했어요', error?.message ?? '다시 시도해 주세요.'); }
    finally { setBusy(false); }
  };

  const removeCollaborator = async (target: Collaborator) => {
    if (!selected || !me) return;
    setBusy(true);
    try {
      await api(`/v1/projects/${selected.id}/collaborators/${target.id}?user_id=${me.user_id}`, { method: 'DELETE' });
      await refresh(); setCollabEditing(null);
    } catch (error: any) { notify('해제하지 못했어요', error?.message ?? '다시 시도해 주세요.'); }
    finally { setBusy(false); }
  };

  const mediaUriOf = (project: Project | null) => project?.videoUrl ? new URL(project.videoUrl, API).toString() : undefined;

  const framesKey = selected ? `${selected.id}:${selected.sourceSha256 ?? ''}` : '';

  useEffect(() => {
    if (!selected?.sourceSha256 || projectFrames.key === framesKey) return;
    if (!['version', 'overlay', 'data'].includes(page)) return;
    // 영상이 바뀌었으면 재생 위치도 되돌린다 — 짧은 클립에서 예전 위치로 탐색하면 어긋난다
    playbackRef.current = 0; liveFrameRef.current = 0;
    api(`/v1/projects/${selected.id}/frames`)
      .then(data => setProjectFrames({ key: framesKey, frames: data?.frames ?? [] }))
      .catch(() => setProjectFrames({ key: framesKey, frames: [] }));
  }, [framesKey, page]);

  const processing = !!job && job.stage !== 'done' && job.stage !== 'error';

  const commitProject = async () => {
    if (!me) return;
    setBusy(true);
    try {
      const created: Project = await api('/v1/projects', { method: 'POST', body: {
        user_id: me.user_id, name: name.trim(), license, color: '#7FA5FF', motion: motionRef,
      } });
      await refresh();
      setSelectedId(created.id);
      setProjectFrames({ key: '', frames: [] });
      setOverlayIndex(0); playbackRef.current = 0; liveFrameRef.current = 0; setStageMode('overlay');
      setName(''); setAsset(null); setJob(null); setPendingPublish(false); setPoseFrames(0);
      setMotionFrames([]); setPreviewUrls({}); setVideoSize(null); setMotionRef(null);
      go('version');
    } catch (error: any) { notify('게시하지 못했어요', error?.message ?? '서버 상태를 확인해 주세요.'); }
    finally { setBusy(false); }
  };

  const publishOriginal = () => {
    if (!asset) return notify('영상이 필요해요', '카메라로 촬영하거나 기존 영상을 선택해 주세요.');
    // 분석이 끝나길 기다리게 하지 않는다 — 예약해 두면 끝나는 즉시 자동으로 게시된다
    if (processing) { setPendingPublish(current => !current); return; }
    commitProject();
  };

  useEffect(() => { if (pendingPublish && job?.stage === 'done') commitProject(); }, [pendingPublish, job?.stage]);
  useEffect(() => { if (proposePending && proposeJob?.stage === 'done') submitProposal(); }, [proposePending, proposeJob?.stage]);
  const Home = () => <SafeAreaView style={s.safe}><Header title="choreo / hub" /><ScrollView contentContainerStyle={s.content}>
    <Text style={s.kicker}>GOOD MORNING, {me?.name?.toUpperCase() ?? ''}</Text><Text style={s.editorialTitle}>움직임에{`\n`}이름을 남기세요.</Text><Text style={s.intro}>당신의 안무는 누군가의 출발점이 됩니다. 원작과 모든 기여를 한곳에 기록하세요.</Text>
    {remoteProjects[0] ? <Pressable style={s.feature} onPress={() => open(remoteProjects[0])}><View style={s.featureTop}><Text style={s.featureLabel}>NOW IN YOUR ARCHIVE</Text><Text style={s.featureArrow}>↗</Text></View><Text style={s.featureTitle}>{remoteProjects[0].name}</Text><View style={s.wave}><View style={s.waveCircle}/><View style={s.waveLine}/><View style={s.waveDot}/><View style={s.waveLineShort}/></View><View style={s.featureBottom}><Text style={s.featureCopy}>{remoteProjects[0].isOwner ? '내 작업' : `${remoteProjects[0].ownerName}님의 작업`} · 함께 만드는 사람 {remoteProjects[0].collaborators.length}명</Text><Pill name={remoteProjects[0].license}/></View></Pressable>
      : <Pressable style={s.feature} onPress={() => go('library')}><View style={s.featureTop}><Text style={s.featureLabel}>START HERE</Text><Text style={s.featureArrow}>↗</Text></View><Text style={s.featureTitle}>첫 안무 올리기</Text><View style={s.wave}><View style={s.waveCircle}/><View style={s.waveLine}/><View style={s.waveDot}/><View style={s.waveLineShort}/></View><View style={s.featureBottom}><Text style={s.featureCopy}>＋ 로 영상을 올리거나 초대 코드로 참여하세요</Text></View></Pressable>}
    <View style={s.rowHeading}><Text style={s.sectionInk}>오늘의 흐름</Text><Text style={s.seeAll}>모두 보기</Text></View>
    <Pressable style={s.checkCard} onPress={() => go('passport')}><View style={s.checkIcon}><Text style={s.checkIconText}>⌁</Text></View><View style={s.grow}><Text style={s.checkTitle}>Fork 관계 연결하기</Text><Text style={s.checkCopy}>원작을 연결하고, 수정한 구간과 크레딧을 남기세요.</Text></View><Text style={s.chev}>›</Text></Pressable>
    <View style={s.rowHeading}><Text style={s.sectionInk}>내 작업</Text><Pressable onPress={()=>setFilter(filter==='전체'?'진행중':'전체')}><Text style={s.seeAll}>{filter==='전체'?'진행 중':'전체 보기'}</Text></Pressable></View>
    {remoteProjects.filter((_, index) => filter === '전체' || index < 2).map(project => <Pressable key={project.id} style={s.project} onPress={() => open(project)}><MotionMark color={project.color}/><View style={s.grow}><Text style={s.projectName}>{project.name}</Text><Text style={s.meta}>{project.version} · {project.date}</Text></View><Pill name={project.license}/></Pressable>)}
    <Pressable style={s.passport} onPress={() => go('passport')}><Text style={s.passIcon}>✦</Text><View><Text style={s.passTitle}>Choreo Passport</Text><Text style={s.passSub}>나의 창작 이력과 크레딧을 한 장으로</Text></View><Text style={s.chev}>›</Text></Pressable>
  </ScrollView><Bottom page="home" go={navTo} plus={() => setModal(true)}/></SafeAreaView>;
  // 이름과 공유 범위는 New 화면에서 받는다 (분석 중에도 입력할 수 있어야 하므로).
  // 이 시트는 무엇이 기록되는지만 알려 주는 시작점이다.
  const CreateModal = () => <Modal visible={modal} transparent animationType="slide" onRequestClose={() => setModal(false)}><Pressable style={s.overlay} onPress={() => setModal(false)}><Pressable style={s.sheet} onPress={() => {}}><View style={s.handle}/><Text style={s.sheetTitle}>새 안무 프로젝트</Text>
    {[['영상을 올리면 바로 분석이 시작돼요','기다리는 동안 제목과 공유 범위를 정할 수 있어요'],['33개 관절을 3D로 기록해요','원본 위에 겹쳐 보거나 스켈레톤만 볼 수 있어요'],['버전과 기여가 함께 남아요','Fork와 공동작업이 원작과 이어집니다']].map(([title, copy], index) => <View style={s.step} key={title}><Text style={s.stepNo}>0{index+1}</Text><View style={s.grow}><Text style={s.tipTitle}>{title}</Text><Text style={s.meta}>{copy}</Text></View></View>)}
    <Pressable style={s.primary} onPress={() => { setModal(false); setName(''); setAsset(null); setJob(null); go('new'); }}><Text style={s.primaryText}>영상 올리고 시작하기</Text></Pressable></Pressable></Pressable></Modal>;
  const AnalysisCard = () => {
    if (!job) return null;
    if (job.stage === 'error') return <View style={s.jobCard}><View style={s.jobHead}><Text style={s.jobTitle}>분석을 마치지 못했어요</Text><Pressable onPress={() => asset && processMotion(asset)}><Text style={s.jobRetry}>다시 시도</Text></Pressable></View><Text style={s.jobCopy}>{job.error}</Text><Text style={s.jobCopy}>영상은 그대로 연결돼 있어서 지금 게시해도 됩니다.</Text></View>;
    const percent = jobPercent(job);
    const finished = job.stage === 'done';
    return <View style={[s.jobCard, finished && s.jobCardDone]}>
      <View style={s.jobHead}><Text style={s.jobTitle}>{finished ? '분석 완료' : '분석 중'}</Text><Text style={[s.jobPercent, finished && s.jobPercentDone]}>{Math.round(percent)}%</Text></View>
      <View style={s.jobTrack}><View style={[s.jobFill, { width: `${percent}%` }, finished && s.jobFillDone]} /></View>
      <Text style={s.jobCopy}>{stageLabel(job.stage, job.done, job.total)}</Text>
      {!finished && <Text style={s.jobHint}>기다리지 않아도 돼요 — 아래에서 제목과 공유 범위를 먼저 정해 두세요.</Text>}
    </View>;
  };

  const New = () => <SafeAreaView style={s.safe}><Header title="새 프로젝트" back={() => go('home')}/><ScrollView contentContainerStyle={s.content}>
    <Text style={s.eyebrow}>CREATE / ORIGINAL MOTION</Text><Text style={s.title}>안무의 첫 버전을{`\n`}기록하세요</Text>

    {asset ? <MotionPlayer uri={asset.uri} frames={motionFrames} video={videoSize ?? undefined} mode={motionFrames.length ? 'overlay' : 'original'} positionRef={playbackRef} frameRef={liveFrameRef}/>
      : <View style={s.upload}><Text style={s.uploadIcon}>↑</Text><Text style={s.uploadTitle}>안무 영상 추가</Text><Text style={s.uploadCopy}>전신이 보이는 15–60초 영상을 촬영하거나 선택해 주세요.</Text><View style={s.uploadActions}><Pressable style={s.outline} onPress={()=>go('capture')}><Text style={s.outlineText}>카메라 촬영</Text></Pressable><Pressable style={s.outline} onPress={chooseVideo}><Text style={s.outlineText}>영상 선택</Text></Pressable></View></View>}

    {asset ? <View style={s.assetRow}><Text style={s.assetName} numberOfLines={1}>{asset.fileName}</Text><Pressable onPress={chooseVideo}><Text style={s.assetChange}>영상 바꾸기</Text></Pressable></View> : null}

    {AnalysisCard()}

    <Text style={s.label}>프로젝트 이름</Text>
    <TextInput placeholder="예: Sunset Groove" placeholderTextColor="#6E7C86" value={name} onChangeText={setName} style={s.input}/>

    <Text style={s.label}>공유 범위</Text>
    {(Object.keys(licenseColor) as License[]).map(item=><Pressable key={item} style={[s.license,license===item&&s.licenseOn]} onPress={()=>setLicense(item)}><View style={[s.radio,license===item&&{borderColor:licenseColor[item]}]}>{license===item&&<View style={[s.radioIn,{backgroundColor:licenseColor[item]}]}/>}</View><View style={s.grow}><Text style={s.licenseName}>{item}</Text><Text style={s.licenseCopy}>{item==='연습 전용'?'개인 열람과 연습만 허용합니다.':item==='비상업 커버 허용'?'출처 표기 시 비상업 영상 게시가 가능합니다.':item==='리믹스 허용'?'Fork와 2차 창작을 허용합니다.':'공연·광고·교육 사용 전 승인이 필요합니다.'}</Text></View></Pressable>)}

    <View style={s.recordNote}><Text style={s.recordNoteTitle}>권리 기록에 함께 남겨요</Text><Text style={s.recordNoteCopy}>원본 영상 · 8카운트 구성 · 창작자별 기여 · 이용 허락 범위 · 계약/권리 귀속 · 버전 이력</Text></View>

    {pendingPublish && processing ? <Text style={s.notice}>분석이 끝나면 자동으로 게시됩니다. 이 화면을 떠나지 말고 잠시만 기다려 주세요.</Text> : null}
    <Pressable style={[s.primary, !asset && s.primaryDisabled, pendingPublish && processing && s.primaryPending]} onPress={publishOriginal}>
      <Text style={s.primaryText}>{!asset ? '영상을 먼저 추가해 주세요' : pendingPublish && processing ? '게시 예약됨 · 누르면 취소' : processing ? '분석 끝나면 게시하기' : '원작 버전 게시하기'}</Text>
    </Pressable>
  </ScrollView><Bottom page="new" go={navTo} plus={()=>{ setName(''); setAsset(null); setJob(null); go('new'); }}/></SafeAreaView>;

  const Capture = () => <SafeAreaView style={s.safe}><Header title="안무 촬영" back={() => go('new')}/><View style={s.capture}><View style={s.cameraFrame}>{cameraPermission?.granted ? <CameraView ref={cameraRef} style={s.camera} facing="front" mode="video" mirror /> : <View style={s.cameraPermission}><Text style={s.cameraPermissionText}>카메라 권한이 필요합니다.</Text><Pressable style={s.outline} onPress={requestCameraPermission}><Text style={s.outlineText}>카메라 허용</Text></Pressable></View>}<View style={s.cameraGuide}><Text style={s.cameraGuideText}>전신이 화면 안에 들어오도록 서 주세요</Text></View></View><Text style={s.captureHint}>권장 15–60초 · 고정된 카메라 · 밝은 배경</Text><Pressable style={[s.recordButton, recording && s.recording]} onPress={toggleRecording}><View style={s.recordButtonDot}/><Text style={s.recordButtonText}>{recording ? '촬영 종료' : '촬영 시작'}</Text></Pressable></View></SafeAreaView>;
  const Library = () => <SafeAreaView style={s.safe}><Header title="내 작업" back={() => go('home')}/><ScrollView contentContainerStyle={s.content}>
    <Text style={s.eyebrow}>MY CHOREOGRAPHIES</Text><Text style={s.title}>내가 남긴{`\n`}안무 작업들</Text>

    <View style={s.joinCard}>
      <Text style={s.joinLabel}>초대 코드로 참여</Text>
      <View style={s.joinRow}>
        <TextInput placeholder="예: 92EM-GKS8" placeholderTextColor="#6E7C86" value={joinCode} onChangeText={setJoinCode} autoCapitalize="characters" style={[s.input, s.grow]}/>
        <Pressable style={[s.joinButton, busy && s.primaryDisabled]} onPress={joinByCode}><Text style={s.joinButtonText}>참여</Text></Pressable>
      </View>
    </View>

    {serverError ? <Text style={s.notice}>{serverError}</Text> : null}

    {remoteProjects.length ? remoteProjects.map(project => <Pressable key={project.id} style={s.uploadedCard} onPress={() => open(project)}>
      <MotionMark color={project.color}/>
      <View style={s.grow}>
        <Text style={s.projectName}>{project.name}</Text>
        <Text style={s.meta}>{project.version} · {project.date}</Text>
        <Text style={s.uploadedMeta}>{project.isOwner ? `내 작업 · 함께 만드는 사람 ${project.collaborators.length}명` : `${project.ownerName}님의 작업 · 내 권한 ${project.viewerPermission ?? '보기만'}`}</Text>
      </View>
      <Text style={s.chev}>›</Text>
    </Pressable>) : <View style={s.emptyCard}><Text style={s.emptyTitle}>아직 작업이 없어요</Text><Text style={s.emptyCopy}>＋ 로 안무를 올리거나, 받은 초대 코드를 위에 입력해 참여해 보세요.</Text></View>}
  </ScrollView><Bottom page="library" go={navTo} plus={()=>setModal(true)}/></SafeAreaView>;
  const EditPostSheet = () => {
    if (!editOpen) return null;
    return <Modal visible transparent animationType="slide" onRequestClose={() => setEditOpen(false)}>
      <Pressable style={s.overlay} onPress={() => setEditOpen(false)}>
        <Pressable style={s.sheet} onPress={() => {}}>
          <View style={s.handle}/>
          <Text style={s.sheetTitle}>작업 정보 수정</Text>
          {SheetToast()}
          <ScrollView style={s.sheetScroll} contentContainerStyle={s.sheetScrollInner} keyboardShouldPersistTaps="handled">
            <Text style={s.label}>작업 이름</Text>
            <TextInput placeholder="예: Sunset Groove" placeholderTextColor="#6E7C86" value={editDraft.name}
              onChangeText={text => setEditDraft(draft => ({ ...draft, name: text }))} style={s.input}/>
            <Text style={s.label}>공유 범위</Text>
            {(Object.keys(licenseColor) as License[]).map(item => <Pressable key={item} style={[s.license, editDraft.license === item && s.licenseOn]}
              onPress={() => setEditDraft(draft => ({ ...draft, license: item }))}>
              <View style={[s.radio, editDraft.license === item && { borderColor: licenseColor[item] }]}>{editDraft.license === item && <View style={[s.radioIn, { backgroundColor: licenseColor[item] }]}/>}</View>
              <View style={s.grow}><Text style={s.licenseName}>{item}</Text><Text style={s.licenseCopy}>{item === '연습 전용' ? '개인 열람과 연습만 허용합니다. 커뮤니티에 공개되지 않아요.' : item === '비상업 커버 허용' ? '출처 표기 시 비상업 영상 게시가 가능합니다.' : item === '리믹스 허용' ? 'Fork와 2차 창작을 허용합니다.' : '공연·광고·교육 사용 전 승인이 필요합니다.'}</Text></View>
            </Pressable>)}
            <Text style={s.countHint}>영상을 바꾸려면 아래 ‘main 에 버전 올리기’로 새 버전을 올려 주세요 — 그래야 무엇이 언제 바뀌었는지 기록에 남습니다.</Text>
            <Pressable style={[s.primary, busy && s.primaryDisabled]} onPress={saveEditPost}><Text style={s.primaryText}>저장</Text></Pressable>

            {selected?.isOwner ? <View style={s.dangerZone}>
              <Text style={s.dangerZoneTitle}>작업 삭제</Text>
              <Text style={s.dangerZoneCopy}>
                버전 {versions?.main.length ?? 0}개와 참여자 {collaborators.length}명의 기록이 함께 사라집니다. 되돌릴 수 없습니다.
                {'\n'}업로드한 영상 파일은 서버에 남습니다 — 같은 영상을 올린 다른 작업이 가리킬 수 있어서입니다.
              </Text>
              <Text style={s.label}>확인을 위해 “{selected.name}” 을 입력</Text>
              <TextInput placeholder={selected.name} placeholderTextColor="#6E7C86" value={deleteConfirm}
                onChangeText={setDeleteConfirm} style={s.input}/>
              <Pressable style={[s.danger, deleteConfirm.trim() !== selected.name && s.primaryDisabled]} onPress={deletePost}>
                <Text style={s.dangerText}>이 작업을 영구 삭제</Text></Pressable>
            </View> : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>;
  };

  const ProposeSheet = () => {
    if (!proposeOpen) return null;
    const direct = !!versions?.canDecide;
    return <Modal visible transparent animationType="slide" onRequestClose={() => setProposeOpen(false)}>
      <Pressable style={s.overlay} onPress={() => setProposeOpen(false)}>
        <Pressable style={s.sheet} onPress={() => {}}>
          <View style={s.handle}/>
          <Text style={s.sheetTitle}>{direct ? 'main 에 버전 올리기' : '수정 제안 보내기'}</Text>
          {SheetToast()}
          <ScrollView style={s.sheetScroll} contentContainerStyle={s.sheetScrollInner} keyboardShouldPersistTaps="handled">
            <Text style={s.label}>무엇을 고쳤나요</Text>
            <TextInput placeholder="예: 후렴 팔 동작 변형" placeholderTextColor="#6E7C86" value={proposeDraft.title}
              onChangeText={text => setProposeDraft(draft => ({ ...draft, title: text }))} style={s.input}/>
            <Text style={s.label}>고친 구간 · 분:초 <Text style={s.required}>필수</Text></Text>
            <View style={s.countRow}>
              <TextInput placeholder="0:08" placeholderTextColor="#6E7C86" value={proposeDraft.from}
                onChangeText={text => setProposeDraft(draft => ({ ...draft, from: text.replace(/[^0-9:]/g, '') }))} style={[s.input, s.countInput]}/>
              <Text style={s.countDash}>–</Text>
              <TextInput placeholder="0:16" placeholderTextColor="#6E7C86" value={proposeDraft.to}
                onChangeText={text => setProposeDraft(draft => ({ ...draft, to: text.replace(/[^0-9:]/g, '') }))} style={[s.input, s.countInput]}/>
            </View>
            {(() => {
              const end = parseClock(proposeDraft.to);
              const grows = end !== null && !!selected?.workMs && end > selected.workMs;
              return <>
                <Text style={s.countHint}>{selected?.workMs ? `이 작업은 ${fmtMs(selected.workMs)} 길이입니다. ` : ''}어느 부분을 고쳤는지 없으면 크레딧을 나눌 수 없어 반드시 적어야 합니다.</Text>
                {grows ? <Text style={s.growHint}>작품이 {fmtMs(selected!.workMs!)} → {fmtMs(end!)} 로 길어집니다. 뒤로 늘리는 수정이면 그대로 보내세요.</Text> : null}
              </>;
            })()}
            <Text style={s.label}>메모</Text>
            <TextInput placeholder="왜 이렇게 바꿨는지 적어 두면 기록에 함께 남아요" placeholderTextColor="#6E7C86" multiline
              value={proposeDraft.note} onChangeText={text => setProposeDraft(draft => ({ ...draft, note: text }))} style={[s.input, s.inputMulti]}/>

            <Text style={s.label}>구간 영상 (선택)</Text>
            {proposeAsset ? <View style={s.attachCard}>
              <View style={s.attachTop}>
                <Text style={s.attachName} numberOfLines={1}>{proposeAsset.fileName}</Text>
                <Pressable onPress={clearProposalVideo}><Text style={s.attachClear}>빼기</Text></Pressable>
              </View>
              {proposeJob ? proposeJob.stage === 'error' ? <Text style={s.attachError}>{proposeJob.error}</Text> : <>
                <View style={s.attachTrack}><View style={[s.attachFill, { width: `${jobPercent(proposeJob)}%` },
                  proposeJob.stage === 'done' && s.attachFillDone]}/></View>
                <Text style={s.attachStage}>{stageLabel(proposeJob.stage, proposeJob.done, proposeJob.total)}</Text>
              </> : null}
              {proposeMotion?.frame_count ? <Text style={s.attachDone}>포즈 {proposeMotion.frame_count} 프레임이 이 구간 기록에 함께 남습니다.</Text> : null}
            </View> : <Pressable style={s.attachPick} onPress={chooseProposalVideo}>
              <Text style={s.attachPickText}>이 구간을 촬영한 영상 올리기</Text>
              <Text style={s.attachPickNote}>올리면 관절이 함께 분석돼 구간 기록의 근거가 됩니다. 없어도 제안은 보낼 수 있어요.</Text>
            </Pressable>}

            {proposePending && proposeBusy ? <Text style={s.notice}>분석이 끝나면 자동으로 보냅니다. 이 창을 닫지 말고 잠시만 기다려 주세요.</Text> : null}
            <Pressable style={[s.primary, busy && s.primaryDisabled, proposePending && proposeBusy && s.primaryPending]} onPress={submitProposal}>
              <Text style={s.primaryText}>{proposePending && proposeBusy ? '예약됨 · 누르면 취소'
                : proposeBusy ? '분석 끝나면 보내기' : direct ? 'main 에 올리기' : '제안 보내기'}</Text></Pressable>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>;
  };

  // GitHub 의 main 브랜치를 그대로 옮긴 화면. 원작이 v1 이고, 반영된 버전이 위로 쌓인다.
  const Version = () => <SafeAreaView style={s.safe}><Header title={selected!.name} back={() => go('library')}/><ScrollView contentContainerStyle={s.content}>
    <View style={s.hero}><View style={s.grow}><Text style={s.eyebrow}>ORIGINAL REPOSITORY</Text><Text style={s.heroTitle}>{selected!.name}</Text><Text style={s.meta}>{selected!.version} · {selected!.date}</Text></View><MotionMark color={selected!.color} large/></View>
    {canEdit ? <Pressable style={s.editRow} onPress={openEditPost}><Text style={s.editIcon}>✎</Text><View style={s.grow}><Text style={s.editTitle}>작업 정보 수정</Text><Text style={s.meta}>이름 · 공유 범위를 바꿀 수 있어요</Text></View><Text style={s.chev}>›</Text></Pressable> : null}
    <View style={s.owner}><View style={s.avatar}><Text style={s.avatarText}>{initialsOf(selected!.ownerName)}</Text></View><View><Pressable onPress={() => openProfile(selected!.ownerId)}><Text style={[s.ownerName, s.linkName]}>{selected!.ownerName}</Text></Pressable><Text style={s.meta}>{selected!.isOwner ? '원작 안무가 (나)' : '원작 안무가'} · 함께 만드는 사람 {collaborators.length}명</Text></View><View style={s.grow}/><Pill name={selected!.license}/></View>

    {versions?.proposed.length ? <>
      <Text style={s.section}>열린 제안 {versions.proposed.length}개</Text>
      {versions.proposed.map(item => <View key={item.id} style={s.proposalCard}>
        <View style={s.proposalTop}>
          <Text style={s.segTag}>{item.segment}</Text>
          {item.sourceSha256 ? <Text style={s.clipTag}>영상 {item.poseFrames ?? 0}f</Text> : null}
          <Text style={s.grow}/>
          <Text style={s.proposalDate}>{item.date}</Text>
        </View>
        <Text style={s.versionTitle}>{item.title}</Text>
        <Pressable onPress={() => openProfile(item.authorId)}><Text style={s.proposalAuthor}>{item.authorName}</Text></Pressable>
        {item.note ? <Text style={s.proposalNote}>{item.note}</Text> : null}
        {versions.canDecide ? <View style={s.proposalActions}>
          <Pressable style={[s.mergeBtn, busy && s.primaryDisabled]} onPress={() => decideProposal(item, true)}><Text style={s.mergeBtnText}>main 에 반영</Text></Pressable>
          <Pressable style={s.declineBtn} onPress={() => decideProposal(item, false)}><Text style={s.declineBtnText}>거절</Text></Pressable>
        </View> : <Text style={s.proposalWait}>원작자의 확인을 기다리고 있어요</Text>}
      </View>)}
    </> : null}

    <Text style={s.section}>main</Text>
    {versions?.headPinned && versions.headSetByName ? <Text style={s.mapSkipped}>현재 버전을 {versions.headSetByName}님이 직접 지정했습니다{versions.headSetAt ? ` · ${versions.headSetAt}` : ''}. 이후 버전은 이력에 남아 있지만 현재 상태에는 반영되지 않습니다.</Text> : null}
    {versions?.main.length ? [...versions.main].reverse().map((item, order) => {
      const isHead = item.id === versions.headId;
      return <View key={item.id} style={s.mainRow}>
      <View style={s.mainRail}>
        <View style={[s.mainDot, isHead && s.mainDotHead]}/>
        {order < versions.main.length - 1 ? <View style={s.mainLine}/> : null}
      </View>
      <View style={[s.mainCard, isHead && s.mainCardHead]}>
        <View style={s.proposalTop}>
          <Text style={[s.versionNo, isHead && s.versionNoHead]}>v{item.number}</Text>
          <Text style={s.segTag}>{item.segment}</Text>
          {item.sourceSha256 ? <Text style={s.clipTag}>영상 {item.poseFrames ?? 0}f</Text> : null}
          <Text style={s.grow}/>
          {isHead ? <Text style={s.headTag}>현재</Text> : null}
        </View>
        <Text style={s.versionTitle}>{item.title}</Text>
        <Text style={s.mainMeta}>
          <Text style={s.linkName}>{item.authorName}</Text>
          {item.decidedByName && item.decidedByName !== item.authorName ? ` · ${item.decidedByName}님이 반영` : ''}
          {` · ${item.date}`}
        </Text>
        {item.note ? <Text style={s.proposalNote}>{item.note}</Text> : null}
        <View style={s.versionActions}>
          {item.sourceSha256 ? <Pressable style={s.headBtn} onPress={() => openVersionClip(item)}>
            <Text style={s.headBtnText}>구간 영상 보기</Text></Pressable> : null}
          {!isHead && versions.canDecide ? <Pressable style={[s.headBtn, busy && s.primaryDisabled]} onPress={() => setHead(item)}>
            <Text style={s.headBtnText}>이 버전을 현재로</Text></Pressable> : null}
        </View>
      </View>
    </View>; }) : <Text style={s.meta}>아직 기록된 버전이 없어요.</Text>}

    {versions?.canPropose ? <Pressable style={s.secondary} onPress={() => setProposeOpen(true)}>
      <Text style={s.secondaryText}>{versions.canDecide ? 'main 에 버전 올리기' : '수정 제안 보내기'}</Text></Pressable> : null}

    {versions?.declined.length ? <>
      <Text style={s.section}>거절된 제안 {versions.declined.length}개</Text>
      {versions.declined.map(item => <View key={item.id} style={s.declinedRow}>
        <Text style={s.segTag}>{item.segment}</Text>
        <Text style={[s.grow, s.declinedTitle]}>{item.title}</Text>
        <Text style={s.declinedMeta}>{item.authorName}</Text>
      </View>)}
      <Text style={s.countHint}>거절된 제안도 지우지 않고 남깁니다 — 무엇이 논의됐는지가 기록의 일부입니다.</Text>
    </> : null}

    <View style={s.grid}>{[['▶','영상 · 오버레이','overlay'],['⌘','포즈 데이터','data'],['✦','작업 기록','passport'],['♧','협업 공간','collab']].map(([icon,label,target])=><Pressable key={label} style={s.action} onPress={()=>go(target as Page)}><Text style={s.actionIcon}>{icon}</Text><Text style={s.actionText}>{label}</Text></Pressable>)}</View>
  </ScrollView><Bottom page="library" go={navTo} plus={()=>setModal(true)}/></SafeAreaView>;
  const VersionRow = ({title,copy,color}:{title:string;copy:string;color:string}) => <View style={s.versionRow}><View style={[s.status,{backgroundColor:color}]}/><View style={s.grow}><Text style={s.versionTitle}>{title}</Text><Text style={s.meta}>{copy}</Text></View></View>;
  // 예전에는 '원본 영상'과 '모션 오버레이'가 별도 화면이었는데, 오버레이 화면의 '원본'
  // 모드가 원본 화면과 똑같은 것을 보여 주고 있었다. 한 화면으로 합치고 원본 화면에만
  // 있던 소스 정보(제목·업로드일·포즈 프레임 수)를 여기로 가져왔다.
  const Overlay = () => {
    const clip = viewingVersion;
    const frames = clip
      ? (versionFrames.key === clip.id ? versionFrames.frames : [])
      : (projectFrames.key === framesKey ? projectFrames.frames : []);
    const size = clip
      ? (clip.videoWidth && clip.videoHeight ? { width: clip.videoWidth, height: clip.videoHeight } : undefined)
      : (selected!.videoWidth && selected!.videoHeight ? { width: selected!.videoWidth, height: selected!.videoHeight } : undefined);
    const uri = clip?.videoUrl ? new URL(clip.videoUrl, API).toString() : mediaUriOf(selected);
    const modes: [StageMode, string][] = [['original', '원본'], ['overlay', '오버레이'], ['skeleton', '스켈레톤만']];
    const hasMotion = frames.length > 0 && !!size;
    return <SafeAreaView style={s.safe}><Header title="안무 영상" back={() => go('version')}/><ScrollView contentContainerStyle={s.content}>
      <Text style={s.eyebrow}>{clip ? 'SEGMENT CLIP' : 'SOURCE & MOTION'}</Text>
      <Text style={s.title}>{clip ? `v${clip.number} 구간 영상` : '원본 위에서 보는'}{`\n`}{clip ? clip.segment : '움직임의 흐름'}</Text>
      {clip ? <View style={s.clipBanner}>
        <View style={s.grow}><Text style={s.clipBannerTitle}>{clip.title}</Text><Text style={s.clipBannerMeta}>{clip.authorName} · {clip.segment} · 포즈 {clip.poseFrames ?? 0}f</Text></View>
        <Pressable style={s.clipBannerBtn} onPress={closeVersionClip}><Text style={s.clipBannerBtnText}>작품 전체 보기</Text></Pressable>
      </View> : null}

      <View style={s.modeRow}>{modes.map(([value, label]) => <Pressable key={value} style={[s.modeChip, stageMode === value && s.modeChipOn, value !== 'original' && !hasMotion && s.modeChipOff]} onPress={() => setStageMode(value)}><Text style={[s.modeChipText, stageMode === value && s.modeChipTextOn]}>{label}</Text></Pressable>)}</View>
      <MotionPlayer uri={uri} frames={frames} video={size} mode={hasMotion ? stageMode : 'original'} positionRef={playbackRef} frameRef={liveFrameRef}/>

      <View style={s.legend}><View style={s.legendDot}/><Text style={s.legendText}>{hasMotion ? '재생에 맞춰 33개 관절을 실시간으로 그립니다' : '아직 연결된 포즈 데이터가 없어요'}</Text><Text style={s.legendFrame}>{frames.length} frames</Text></View>

      <View style={s.mediaInfo}><Text style={s.mediaTitle}>{clip ? `${selected!.name} · v${clip.number}` : selected!.name}</Text><Text style={s.meta}>{clip ? `${clip.authorName} 의 구간 영상 · ${clip.date}` : `업로드 원본 · ${selected!.date} · ${selected!.ownerName}`}</Text></View>
      <View style={s.dataSummary}><Text style={s.dataSummaryNumber}>{clip ? (clip.poseFrames ?? 0) : (selected!.poseFrames ?? 0)}</Text><Text style={s.dataSummaryCopy}>개의 포즈 프레임이{`\n`}이 영상과 연결되어 있어요</Text></View>

      {frames.length && !size ? <Text style={s.notice}>이 작업은 영상 해상도 정보가 없어 오버레이를 그릴 수 없어요. 새로 업로드하면 표시됩니다.</Text> : null}
      {hasMotion ? <Pressable style={s.secondary} onPress={() => { setOverlayIndex(liveFrameRef.current); go('data'); }}><Text style={s.secondaryText}>지금 이 프레임의 관절 데이터 보기</Text></Pressable> : null}

      <Text style={s.section}>기록된 구간</Text>
      {(versions?.main ?? []).filter(item => item.startMs !== null).length
        ? (versions?.main ?? []).filter(item => item.startMs !== null).map(item => <Pressable style={s.overlayRow} key={item.id}
            onPress={() => item.sourceSha256 ? openVersionClip(item) : notify('이 버전에는 영상이 없어요', '메모와 구간만 기록된 버전입니다.')}>
            <Text style={s.overlayTime}>{item.segment}</Text>
            <Text style={s.overlayLabel}>{item.title} · {item.authorName}</Text>
            <Text style={s.recordCheck}>v{item.number}</Text>
          </Pressable>)
        : <Text style={s.meta}>아직 구간을 지정한 버전이 없어요. 수정 제안을 보낼 때 시간을 적으면 여기에 모입니다.</Text>}
    </ScrollView><Bottom page="library" go={navTo} plus={()=>setModal(true)}/></SafeAreaView>;
  };

  // 예전에는 프레임 하나의 33개 관절을 행으로 늘어놓았다 — 1800 프레임 중 하나를 보려고
  // 33행을 스크롤하는 화면이라 실용성이 없었다. GitHub 저장소의 파일 목록처럼 바꿨다:
  // 무엇이 기록됐는지 보고, 열어 보고, 내려받는다.
  const Data = () => {
    const frames = projectFrames.key === framesKey ? projectFrames.frames : [];
    const index = Math.min(overlayIndex, Math.max(0, frames.length - 1));
    const frame = frames[index];
    const snippet = frame ? JSON.stringify({
      time_ms: frame.time_ms,
      world_landmarks: frame.world_landmarks.slice(0, 2),
    }, null, 2) : null;

    return <SafeAreaView style={s.safe}><Header title="기록 파일" back={() => { setFileView(null); go('overlay'); }}/><ScrollView contentContainerStyle={s.content}>
      <Text style={s.eyebrow}>RECORDED DATA</Text><Text style={s.title}>이 안무가{`\n`}남긴 기록</Text>
      <View style={s.formatRow}><Text style={s.formatBadge}>{fileList?.format ?? 'choreohub-motion-3d/v1'}</Text><Text style={s.meta}>기록 형식</Text></View>

      {fileView ? <View style={s.blob}>
        <View style={s.blobHead}>
          <View style={s.grow}>
            <Text style={s.blobName} numberOfLines={1}>{fileView.name.replace(/^[0-9a-f]{8}[0-9a-f]*\./, '')}</Text>
            <Text style={s.blobMeta}>{fileView.total.toLocaleString()}줄 중 {fileView.shown.toLocaleString()}줄 · {prettyBytes(fileView.bytes)}</Text>
          </View>
          <Pressable onPress={() => setFileView(null)}><Text style={s.blobClose}>닫기</Text></Pressable>
        </View>
        <ScrollView horizontal style={s.blobScroll} contentContainerStyle={s.blobInner}>
          <View>{fileView.lines.map((line, lineIndex) => <View key={lineIndex} style={s.codeRow}>
            <Text style={s.codeNum}>{lineIndex + 1}</Text><Text style={s.codeText}>{line || ' '}</Text>
          </View>)}</View>
        </ScrollView>
        {fileView.truncated ? <Text style={s.blobTrunc}>앞 {fileView.shown}줄만 보여 줍니다. 전체는 내려받아 확인해 주세요.</Text> : null}
        <Pressable style={s.blobDownload} onPress={() => downloadFile(fileView.url, fileView.name)}><Text style={s.blobDownloadText}>전체 파일 내려받기</Text></Pressable>
      </View> : null}

      <Text style={s.section}>파일 {fileList ? `${fileList.files.length}개` : ''}</Text>
      {fileList?.files.length ? fileList.files.map(file => <View key={file.key} style={s.fileRow}>
        <View style={s.grow}>
          <View style={s.fileTop}><Text style={s.fileKind}>{file.kind}</Text><Text style={s.fileLabel}>{file.label}</Text></View>
          <Text style={s.fileNote}>{file.note}</Text>
          <Text style={s.fileSize}>{prettyBytes(file.bytes)}</Text>
        </View>
        <View style={s.fileActions}>
          {file.viewable ? <Pressable style={s.fileBtn} onPress={() => openFileView(file)}><Text style={s.fileBtnText}>보기</Text></Pressable> : null}
          <Pressable style={s.fileBtn} onPress={() => downloadFile(file.url, file.name)}><Text style={s.fileBtnText}>내려받기</Text></Pressable>
        </View>
      </View>) : <View style={s.emptyCard}><Text style={s.emptyTitle}>아직 기록된 파일이 없어요</Text><Text style={s.emptyCopy}>영상을 올리고 분석을 마치면 좌표·표·배열 파일이 여기에 모입니다.</Text></View>}

      {fileList?.source ? <>
        <Text style={s.section}>원본 영상</Text>
        <View style={s.fileRow}>
          <View style={s.grow}>
            <View style={s.fileTop}><Text style={s.fileKind}>mp4</Text><Text style={s.fileLabel}>업로드 원본</Text></View>
            <Text style={s.fileNote}>파일 이름이 곧 SHA-256 해시다 — 같은 영상은 같은 식별자를 갖는다</Text>
            <Text style={s.fileSize}>{prettyBytes(fileList.source.bytes)}</Text>
          </View>
          <View style={s.fileActions}><Pressable style={s.fileBtn} onPress={() => downloadFile(fileList.source!.url, fileList.source!.name)}><Text style={s.fileBtnText}>내려받기</Text></Pressable></View>
        </View>
      </> : null}

      {snippet ? <>
        <Text style={s.section}>지금 보던 프레임</Text>
        <View style={s.blob}>
          <View style={s.blobHead}><View style={s.grow}><Text style={s.blobName}>프레임 {index + 1} / {frames.length}</Text><Text style={s.blobMeta}>{(frame!.time_ms / 1000).toFixed(2)}초</Text></View></View>
          <ScrollView horizontal style={s.blobScroll} contentContainerStyle={s.blobInner}>
            <Text style={s.codeText}>{snippet}</Text>
          </ScrollView>
          <Text style={s.blobTrunc}>관절 2개만 보여 줍니다. 33개 전체는 app_frames.json 에 있습니다.</Text>
        </View>
      </> : null}
    </ScrollView><Bottom page="library" go={navTo} plus={()=>setModal(true)}/></SafeAreaView>;
  };

  const Analysis = () => <SafeAreaView style={s.safe}><Header title="파생 관계" back={() => go('version')}/><ScrollView contentContainerStyle={s.content}><Text style={s.eyebrow}>FORK & CREDIT</Text><Text style={s.title}>원작과 새 작업을{`\n`}정직하게 연결하세요.</Text><View style={s.scoreCard}><Text style={s.scoreLabel}>연결된 원작</Text><Text style={s.score}>01</Text><Text style={s.meta}>Tide marks · ver.3</Text><View style={s.track}><View style={s.fill}/></View></View><View style={s.sourceResult}><Text style={s.sourceResultLabel}>이용 허락</Text><Text style={s.sourceResultTitle}>리믹스 허용 · 크레딧 필수</Text><Text style={s.sourceResultCopy}>원작자, 변경 구간, 새 기여자를 Passport와 버전 이력에 함께 남깁니다.</Text><Pill name="원작 연결됨"/></View><Text style={s.section}>수정 범위</Text>{[['01–04','원작 동작 유지','#4FC7A2'],['05–08','팔 동작 변형 · BADA','#E0AE3C'],['09–12','전환 동선 추가 · MIA','#B490E8']].map(([count,copy,color])=><Pressable key={count} style={s.analysis} onPress={()=>go('motion')}><View style={[s.status,{backgroundColor:color}]}/><View style={s.grow}><Text style={s.count}>{count} COUNT</Text><Text style={s.analysisCopy}>{copy}</Text></View><Text style={s.chev}>›</Text></Pressable>)}<Pressable style={s.secondary} onPress={()=>go('motion')}><Text style={s.secondaryText}>변경 구간 기록하기</Text></Pressable></ScrollView><Bottom page="home" go={navTo} plus={()=>setModal(true)}/></SafeAreaView>;
  const Motion = () => <SafeAreaView style={s.safe}><Header title="수정 제안 상세" back={() => go('analysis')}/><ScrollView contentContainerStyle={s.content}><View style={s.stage}><Text style={s.stageTag}>COUNT 05–08</Text><Text style={s.skeleton}>●{`\n`}╱│╲{`\n`} ╱ ╲</Text><View style={s.joint}><Text style={s.jointName}>변경 제안</Text><Text style={s.jointValue}>BADA</Text></View></View><Text style={s.section}>기여 기록</Text><Tip index="01" title="팔 동작을 새롭게 구성했어요" copy="원작의 중심 이동은 유지하고, 양팔의 궤적을 새 버전으로 제안합니다."/><Tip index="02" title="크레딧과 변경 이유를 남겨요" copy="승인되면 기여자와 변경 구간이 버전 이력에 자동으로 연결됩니다."/><Pressable style={s.primary} onPress={()=>notify('수정 제안 저장','수정 범위와 기여 기록을 저장했습니다.')}><Text style={s.primaryText}>수정 제안 저장</Text></Pressable></ScrollView><Bottom page="home" go={navTo} plus={()=>setModal(true)}/></SafeAreaView>;
  const Tip = ({index,title,copy}:{index:string;title:string;copy:string}) => <View style={s.tip}><Text style={s.tipIndex}>{index}</Text><View style={s.grow}><Text style={s.tipTitle}>{title}</Text><Text style={s.tipCopy}>{copy}</Text></View></View>;
  const CollabSheet = () => {
    if (!collabEditing) return null;
    const editing = collabEditing !== 'new';
    return <Modal visible transparent animationType="slide" onRequestClose={() => setCollabEditing(null)}>
      <Pressable style={s.overlay} onPress={() => setCollabEditing(null)}>
        <Pressable style={s.sheet} onPress={() => {}}>
          <View style={s.handle}/>
          <Text style={s.sheetTitle}>{editing ? '참여 정보 수정' : '공동 작업자 초대'}</Text>
          {SheetToast()}
          <ScrollView style={s.sheetScroll} contentContainerStyle={s.sheetScrollInner} keyboardShouldPersistTaps="handled">
          <Text style={s.label}>이름 또는 활동명</Text>
          <TextInput placeholder="예: BADA" placeholderTextColor="#6E7C86" value={collabDraft.name} onChangeText={text => setCollabDraft(draft => ({ ...draft, name: text }))} style={s.input}/>
          <Text style={s.label}>맡은 역할</Text>
          <TextInput placeholder="예: 포메이션 구성" placeholderTextColor="#6E7C86" value={collabDraft.role} onChangeText={text => setCollabDraft(draft => ({ ...draft, role: text }))} style={s.input}/>
          <Text style={s.label}>기여 구간</Text>
          <TextInput placeholder="예: count 09–16" placeholderTextColor="#6E7C86" value={collabDraft.counts} onChangeText={text => setCollabDraft(draft => ({ ...draft, counts: text }))} style={s.input}/>
          <Text style={s.label}>수정 권한</Text>
          {PERMISSIONS.map(item => <Pressable key={item} style={[s.license, collabDraft.permission === item && s.licenseOn]} onPress={() => setCollabDraft(draft => ({ ...draft, permission: item }))}>
            <View style={[s.radio, collabDraft.permission === item && { borderColor: PURPLE }]}>{collabDraft.permission === item && <View style={[s.radioIn, { backgroundColor: PURPLE }]}/>}</View>
            <View style={s.grow}><Text style={s.licenseName}>{item}</Text><Text style={s.licenseCopy}>{permissionCopy[item]}</Text></View>
          </Pressable>)}
          <Pressable style={s.primary} onPress={saveCollaborator}><Text style={s.primaryText}>{editing ? '수정 내용 저장' : '초대하고 기록에 남기기'}</Text></Pressable>
          {editing ? <Pressable style={s.danger} onPress={() => removeCollaborator(collabEditing)}><Text style={s.dangerText}>이 작업에서 참여 해제</Text></Pressable> : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>;
  };

  const Collab = () => <SafeAreaView style={s.safe}><Header title="협업 공간" back={() => go('version')}/><ScrollView contentContainerStyle={s.content}>
    <Text style={s.eyebrow}>COLLABORATORS</Text><Text style={s.title}>안무는 함께{`\n`}완성됩니다.</Text>

    <View style={s.summary}><Text style={s.summaryNumber}>{collaborators.length}</Text><Text style={s.summaryCopy}>함께 만드는 사람</Text><Text style={s.summaryNumber}>{collaborators.filter(item => item.permission === '직접 수정').length}</Text><Text style={s.summaryCopy}>직접 수정 가능</Text></View>

    <View style={s.inviteCard}>
      <Text style={s.inviteLabel}>초대 링크</Text>
      <Text style={s.inviteCode} selectable>{selected!.inviteCode}</Text>
      <Text style={s.inviteCopy}>이 링크를 받은 사람은 아래에서 정한 권한만큼 이 작업에 참여합니다.</Text>
      {canEdit ? <Pressable style={s.invitePrimary} onPress={() => openCollabSheet('new')}><Text style={s.primaryText}>공동 작업자 초대</Text></Pressable>
        : <Text style={s.inviteCopy}>초대는 원작자와 '직접 수정' 권한을 가진 사람만 할 수 있어요.</Text>}
    </View>

    <Text style={s.section}>함께 만드는 사람</Text>
    {collaborators.length ? collaborators.map(item => <Pressable style={s.request} key={item.id} onPress={() => canEdit && openCollabSheet(item)}>
      <View style={s.avatar}><Text style={s.avatarText}>{initialsOf(item.name)}</Text></View>
      <View style={s.grow}>
        <Pressable onPress={() => item.user_id && openProfile(item.user_id)}><Text style={[s.versionTitle, item.user_id && s.linkName]}>{item.name}</Text></Pressable>
        <Text style={s.meta}>{item.role} · {item.counts}</Text>
        <Text style={[s.collabPermission, item.permission === '직접 수정' && s.collabPermissionStrong]}>{item.permission}{item.joined ? ' · 참여 중' : ' · 초대함'}</Text>
      </View>
      <Text style={s.chev}>›</Text>
    </Pressable>) : <View style={s.emptyCard}><Text style={s.emptyTitle}>아직 함께하는 사람이 없어요</Text><Text style={s.emptyCopy}>초대하면 누가 어느 구간을 만들었는지 이 작업 기록에 함께 남습니다.</Text></View>}

    <Text style={s.section}>이렇게 기록돼요</Text>
    <View style={s.recordNote}><Text style={s.recordNoteTitle}>{selected.name}</Text><Text style={s.recordNoteCopy}>원작 · {selected!.ownerName}{collaborators.length ? ` · 함께 만든 사람 ${collaborators.length}명 (${collaborators.map(item => item.name).join(', ')})` : ''}</Text></View>
  </ScrollView><Bottom page="home" go={navTo} plus={()=>setModal(true)}/></SafeAreaView>;
  const Perform = () => <SafeAreaView style={s.safe}><Header title="3D 퍼페이션" back={() => go('version')}/><View style={s.perform}><View style={s.performStage}><Text style={s.stageGrid}>╱╲╱╲╱╲{`\n`}╲╱╲╱╲╱{`\n`}╱╲╱╲╱╲</Text><Text style={s.avatar3d}>●{`\n`}╱│╲{`\n`} ╱ ╲</Text><View style={s.play}><Text style={s.playText}>▶</Text></View></View><View style={s.player}><Text style={s.section}>Serenade · ver.3</Text><Text style={s.meta}>ORIGINAL MOTION · 00:14 / 00:30</Text><View style={s.timeline}><View style={s.timeFill}/></View><Text style={s.controls}>↺     ▶     ↻</Text></View></View><Bottom page="home" go={navTo} plus={()=>setModal(true)}/></SafeAreaView>;
  // GitHub 프로필의 뼈대를 그대로 가져왔다 — 신원 헤더, 숫자 요약, 기여 달력, 고정한 작업,
  // 최근 활동. 기여 색은 초록 대신 브랜드 파랑 5단계를 쓴다.
  const CONTRIB_SCALE = ['#242E36', '#26375A', '#3E5C99', '#5C86D8', PURPLE];
  const contribColor = (count: number) => count <= 0 ? CONTRIB_SCALE[0]
    : count === 1 ? CONTRIB_SCALE[1] : count === 2 ? CONTRIB_SCALE[2] : count <= 4 ? CONTRIB_SCALE[3] : CONTRIB_SCALE[4];

  const Profile = () => {
    const stats: [string, string][] = profile ? [
      [String(profile.stats.owned), '원작 작업'],
      [String(profile.stats.joined), '참여 중'],
      [String(profile.stats.people), '함께한 사람'],
      [profile.stats.frames > 999 ? `${Math.round(profile.stats.frames / 1000)}k` : String(profile.stats.frames), '포즈 프레임'],
    ] : [];
    const mine = !profile || profile.isMe;
    return <SafeAreaView style={s.safe}>
      <Header title={mine ? '내 프로필' : (profile?.name ?? '프로필')} back={mine ? undefined : () => { setViewingUserId(null); go('community'); }}/>
      <ScrollView contentContainerStyle={s.content}>
      <View style={s.ghHead}>
        <View style={s.ghAvatar}><Text style={s.ghAvatarText}>{initialsOf(profile?.name ?? me?.name ?? '?')}</Text></View>
        <View style={s.grow}>
          <Text style={s.ghName}>{profile?.name ?? me?.name ?? '—'}</Text>
          <Text style={s.ghHandle}>@{profile?.handle ?? '…'}</Text>
          <Text style={s.ghJoined}>{profile ? `${profile.joinedAt}부터 함께하고 있어요` : '불러오는 중…'}</Text>
        </View>
      </View>

      {profile ? <View style={s.ghFollowRow}>
        <Pressable onPress={() => {}}><Text style={s.ghFollowStat}><Text style={s.ghFollowNum}>{profile.followers}</Text> 팔로워</Text></Pressable>
        <Pressable onPress={() => {}}><Text style={s.ghFollowStat}><Text style={s.ghFollowNum}>{profile.following}</Text> 팔로잉</Text></Pressable>
        {!profile.isMe ? <Pressable style={[s.followBtn, profile.isFollowing && s.followBtnOn]} onPress={() => toggleFollow(profile.user_id, profile.isFollowing)}>
          <Text style={[s.followBtnText, profile.isFollowing && s.followBtnTextOn]}>{profile.isFollowing ? '팔로잉' : '팔로우'}</Text></Pressable> : null}
      </View> : null}

      <View style={s.ghStats}>{stats.map(([value, label]) => <View key={label} style={s.ghStat}>
        <Text style={s.ghStatNum}>{value}</Text><Text style={s.ghStatLabel}>{label}</Text>
      </View>)}</View>

      <Text style={s.section}>{profile ? `지난 1년간 ${profile.contributions.total}번의 기록` : '기여 그래프'}</Text>
      {profile ? <View style={s.ghGraphCard}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.ghGraphInner}
          ref={graphRef} onContentSizeChange={() => graphRef.current?.scrollToEnd({ animated: false })}>
          <View>
            <View style={s.ghMonthRow}>{profile.contributions.months.map(month => <Text key={`${month.label}-${month.week}`} style={[s.ghMonth, { left: month.week * 14 }]}>{month.label}</Text>)}</View>
            <View style={s.ghWeeks}>{profile.contributions.weeks.map((week, weekIndex) => <View key={weekIndex} style={s.ghWeek}>
              {week.map(day => <View key={day.d} style={[s.ghCell, { backgroundColor: day.c < 0 ? 'transparent' : contribColor(day.c) }]}/>)}
            </View>)}</View>
          </View>
        </ScrollView>
        <View style={s.ghLegend}>
          <Text style={s.ghLegendText}>적음</Text>
          {CONTRIB_SCALE.map(color => <View key={color} style={[s.ghCell, { backgroundColor: color }]}/>)}
          <Text style={s.ghLegendText}>많음</Text>
        </View>
      </View> : null}

      <Text style={s.section}>고정한 작업</Text>
      {profile?.projects.length ? profile.projects.map(item => {
        const full = remoteProjects.find(project => project.id === item.id);
        return <Pressable key={item.id} style={s.ghPin} onPress={() => full && open(full)}>
          <View style={s.ghPinTop}><MotionMark color={item.color}/><View style={s.grow}><Text style={s.projectName}>{item.name}</Text><Text style={s.meta}>{item.version}</Text></View></View>
          <View style={s.ghPinBottom}><Pill name={item.license}/><Text style={s.ghPinRole}>{item.isOwner ? '원작' : '참여'}</Text></View>
        </Pressable>;
      }) : <View style={s.emptyCard}><Text style={s.emptyTitle}>아직 고정할 작업이 없어요</Text><Text style={s.emptyCopy}>안무를 올리거나 초대 코드로 참여하면 여기에 모입니다.</Text></View>}

      <Text style={s.section}>최근 활동</Text>
      {profile?.activity.length ? profile.activity.map((item, index) => <View key={`${item.date}-${index}`} style={s.ghActivity}>
        <View style={[s.ghDot, { backgroundColor: item.kind === 'project' ? PURPLE : item.kind === 'invite' ? '#4FC7A2' : '#FF8B77' }]}/>
        <Text style={[s.grow, s.activityText]}>{item.text}</Text>
        <Text style={s.ghActivityDate}>{item.date.slice(5)}</Text>
      </View>) : <Text style={s.meta}>아직 기록된 활동이 없어요.</Text>}

      {mine ? <><Text style={s.section}>설정</Text>
      <Pressable style={s.setting} onPress={()=>go('license')}><Text style={s.settingIcon}>⚙</Text><View style={s.grow}><Text style={s.versionTitle}>기본 이용 허락 범위</Text><Text style={s.meta}>작품마다 세부 설정 가능</Text></View><Text style={s.chev}>›</Text></Pressable>
      <Pressable style={s.danger} onPress={signOut}><Text style={s.dangerText}>이 기기에서 로그아웃</Text></Pressable></> : null}
    </ScrollView><Bottom page="profile" go={navTo} plus={()=>setModal(true)}/></SafeAreaView>;
  };

  // ── 탐색: 사람과 공개 작업 ──
  const CommunityPage = () => <SafeAreaView style={s.safe}><Header title="탐색"/><ScrollView contentContainerStyle={s.content}>
    <Text style={s.eyebrow}>COMMUNITY</Text><Text style={s.title}>다른 안무가들은{`\n`}무엇을 만들고 있을까요</Text>

    <Text style={s.section}>안무가</Text>
    {community?.people.length ? community.people.map(person => <Pressable key={person.user_id} style={s.personRow} onPress={() => openProfile(person.user_id)}>
      <View style={s.personAvatar}><Text style={s.personAvatarText}>{initialsOf(person.name)}</Text></View>
      <View style={s.grow}>
        <Text style={s.versionTitle}>{person.name}{person.isMe ? ' (나)' : ''}</Text>
        <Text style={s.meta}>@{person.handle} · 공개 작업 {person.works}개 · 팔로워 {person.followers}</Text>
      </View>
      {person.isMe ? null : <Pressable style={[s.followBtn, person.isFollowing && s.followBtnOn]} onPress={() => toggleFollow(person.user_id, person.isFollowing)}>
        <Text style={[s.followBtnText, person.isFollowing && s.followBtnTextOn]}>{person.isFollowing ? '팔로잉' : '팔로우'}</Text></Pressable>}
    </Pressable>) : <Text style={s.meta}>아직 다른 안무가가 없어요.</Text>}

    <Text style={s.section}>공개된 작업</Text>
    {community?.feed.length ? community.feed.map(item => <View key={item.id} style={s.feedCard}>
      <View style={s.ghPinTop}><MotionMark color={item.color}/><View style={s.grow}>
        <Text style={s.projectName}>{item.name}</Text>
        <Pressable onPress={() => openProfile(item.ownerId)}><Text style={s.feedOwner}>{item.ownerName}</Text></Pressable>
      </View></View>
      <View style={s.ghPinBottom}><Pill name={item.license}/><Text style={s.ghPinRole}>{item.date} · 함께 {item.people}명{item.poseFrames ? ` · ${item.poseFrames} 프레임` : ''}</Text></View>
    </View>) : <Text style={s.meta}>아직 공개된 작업이 없어요.</Text>}

    <Text style={s.notice}>‘연습 전용’으로 설정한 작업은 여기에 나타나지 않습니다.</Text>
  </ScrollView><Bottom page="community" go={navTo} plus={()=>setModal(true)}/></SafeAreaView>;
  // 작업 기록 — 하드코딩된 카드가 아니라 실제 버전 사슬과 참여자에서 만든다.
  /**
   * 구간별 크레딧 — 어느 8카운트가 누구 것인지.
   *
   * v1(전체)이 바탕이고, 번호가 큰 버전이 자기 구간을 덮어쓴다. 즉 "가장 최근에 그 구간을
   * 고친 사람"이 그 구간의 크레딧을 갖는다. 구간을 카운트 정수로 저장해 둔 덕에 계산된다.
   */
  const creditMap = () => {
    const all = versions?.main ?? [];
    const headNumber = all.find(item => item.id === versions?.headId)?.number ?? Infinity;
    // 현재 버전보다 뒤의 버전은 현재 상태가 아니므로 크레딧에 넣지 않는다
    const chain = all.filter(item => (item.number ?? 0) <= headNumber);
    if (!chain.length) return null;
    // 1초 버킷으로 잘라 구간 소유자를 채운다. 작품 타임라인 길이는 v1 이 정하지만,
    // 영상 길이를 모르는 옛 작업도 있으므로 구간의 끝까지로 대체한다 (없으면 맵을 그리지 않는다).
    const totalMs = selected?.workMs
      || Math.max(0, ...chain.map(item => item.durationMs ?? 0))
      || Math.max(0, ...chain.map(item => item.endMs ?? 0));
    if (!totalMs) return null;
    const maxCount = Math.max(1, Math.round(totalMs / 1000));
    const lengthKnown = !!(selected?.workMs || chain.some(item => item.durationMs));
    const owner: string[] = new Array(maxCount + 1).fill('');
    // v1(원작)만 전체를 바탕으로 깔고, 이후 버전은 자기 구간만 덮는다.
    // 구간이 없는 후속 버전은 맵에서 제외한다 — 전체를 주장해 남의 크레딧을 삼켜 버린다.
    let skipped = 0;
    for (const item of chain) {
      const isOrigin = item.number === 1;
      if (!isOrigin && (item.startMs === null || item.endMs === null)) { skipped += 1; continue; }
      const from = isOrigin ? 1 : Math.max(1, Math.floor((item.startMs as number) / 1000) + 1);
      const to = isOrigin ? maxCount : Math.min(maxCount, Math.ceil((item.endMs as number) / 1000));
      for (let count = from; count <= to; count += 1) owner[count] = item.authorName;
    }

    // 원작자를 항상 첫 색(브랜드 파랑)으로 고정하고, 나머지는 구간 순서로 배정한다
    const order: string[] = [selected!.ownerName];
    for (let count = 1; count <= maxCount; count += 1) {
      if (owner[count] && !order.includes(owner[count])) order.push(owner[count]);
    }
    const UNCLAIMED = '#3A444C';
    const colorOf = (name: string) => name ? CREDIT_COLORS[Math.max(0, order.indexOf(name)) % CREDIT_COLORS.length] : UNCLAIMED;

    const blocks: { name: string; from: number; to: number }[] = [];
    for (let count = 1; count <= maxCount; count += 1) {
      const last = blocks[blocks.length - 1];
      if (last && last.name === owner[count]) last.to = count;
      else blocks.push({ name: owner[count], from: count, to: count });
    }

    const shares = order.filter(name => owner.includes(name)).map(name => {
      const total = owner.filter(item => item === name).length;
      return { name, total, percent: Math.round((total / maxCount) * 100), color: colorOf(name) };
    }).sort((a, b) => b.total - a.total);

    return { maxCount, blocks, shares, colorOf, skipped, lengthKnown };
  };

  /** 버전 사슬 · 참여자 · 공유 설정을 하나의 크레딧 트리로 묶는다. */
  const creditTree = (): CreditNode[] => {
    const chain = versions?.main ?? [];
    const open = versions?.proposed ?? [];
    const turned = versions?.declined ?? [];
    const origin = chain[0];
    const tree: CreditNode[] = [];

    tree.push({ label: '원작', tone: 'accent', children: [{
      label: selected!.ownerName,
      sub: `${origin ? origin.date : selected!.date} · ${origin?.segment ?? '전체'}${origin?.poseFrames ? ` · 포즈 ${origin.poseFrames}f` : ''}`,
    }] });

    tree.push({ label: `main · ${chain.length}개 버전`, tone: 'accent',
      children: chain.length ? chain.map(item => ({
        label: `v${item.number}  ${item.segment}`,
        sub: `${item.title} · ${item.authorName}`
          + (item.decidedByName && item.decidedByName !== item.authorName ? ` · ${item.decidedByName} 반영` : '')
          + (item.sourceSha256 ? ` · 영상 ${item.poseFrames ?? 0}f` : ''),
      })) : [{ label: '아직 버전이 없어요', tone: 'muted' }] });

    if (collaborators.length) tree.push({ label: `함께 만든 사람 · ${collaborators.length}명`, tone: 'accent',
      children: collaborators.map(item => ({
        label: item.name,
        sub: `${item.role} · ${item.counts} · ${item.permission}${item.joined ? ' · 참여 중' : ' · 초대함'}`,
      })) });

    if (open.length) tree.push({ label: `검토 중 · ${open.length}건`, tone: 'warn',
      children: open.map(item => ({ label: `${item.segment}  ${item.title}`, sub: `${item.authorName} · ${item.date}`, tone: 'warn' })) });

    if (turned.length) tree.push({ label: `반영하지 않음 · ${turned.length}건`, tone: 'muted',
      children: turned.map(item => ({ label: `${item.segment}  ${item.title}`, sub: `${item.authorName} · ${item.decidedByName ?? ''} 확인`, tone: 'muted' })) });

    tree.push({ label: '공유 설정', tone: 'accent', children: [
      { label: selected!.license, sub: selected!.license === '연습 전용' ? '커뮤니티에 공개되지 않음' : '탐색 피드에 공개됨' },
      { label: `기록 형식 · choreohub-motion-3d/v1`, sub: selected!.sourceSha256 ? `원본 해시 ${selected!.sourceSha256.slice(0, 12)}…` : '원본 영상 없음' },
    ] });
    return tree;
  };

  const Passport = () => {
    const chain = versions?.main ?? [];
    const head = chain[chain.length - 1];
    const contributors = Array.from(new Set(chain.slice(1).map(item => item.authorName)));
    const covered = chain.filter(item => item.startMs !== null);
    return <SafeAreaView style={s.safe}><Header title="작업 기록" back={() => go('version')}/><ScrollView contentContainerStyle={s.content}>
      <Text style={s.eyebrow}>CREATIVE RECORD</Text><Text style={s.title}>{selected!.name}이(가){`\n`}남긴 기록</Text>

      <View style={s.passportScore}>
        <Text style={s.passportScoreNumber}>{chain.length}<Text style={s.passportScoreTotal}> ver.</Text></Text>
        <View style={s.grow}>
          <Text style={s.passportScoreTitle}>{head ? `현재 main · v${head.number}` : '아직 버전이 없어요'}</Text>
          <Text style={s.passportScoreCopy}>{head ? `${head.title} · ${head.segment}` : '원작을 등록하면 v1 이 만들어집니다.'}</Text>
        </View>
      </View>

      <View style={s.recordStats}>
        {[[String(chain.length), '반영된 버전'], [String(contributors.length + 1), '기여한 사람'],
          [String(versions?.proposed.length ?? 0), '열린 제안'], [String(covered.length), '기록된 구간']]
          .map(([value, label]) => <View key={label} style={s.recordStat}>
            <Text style={s.recordStatNum}>{value}</Text><Text style={s.recordStatLabel}>{label}</Text></View>)}
      </View>

      {(() => {
        const map = creditMap();
        if (!map) return null;
        // 4등분 눈금 — 초 단위는 8칸씩 끊으면 너무 촘촘하다
        const ticks = [1, 2, 3, 4].map(part => Math.round((map.maxCount * part) / 4));
        return <>
          <Text style={s.section}>구간별 크레딧</Text>
          <View style={s.mapCard}>
            <View style={s.mapBar}>
              {map.blocks.map(block => <View key={`${block.from}`} style={[s.mapBlock, { flex: block.to - block.from + 1, backgroundColor: map.colorOf(block.name) }]}>
                {block.to - block.from >= 3 ? <Text style={s.mapBlockText} numberOfLines={1}>{fmtMs((block.from - 1) * 1000)}–{fmtMs(block.to * 1000)}</Text> : null}
              </View>)}
            </View>
            <View style={s.mapTicks}>{ticks.map(tick => <Text key={tick} style={[s.mapTick, { flex: 1 }]}>{fmtMs(tick * 1000)}</Text>)}</View>
            <Text style={s.mapAxis}>작품 타임라인 · 전체 {fmtMs(map.maxCount * 1000)}{map.lengthKnown ? '' : ' (영상 길이 정보 없음 — 기록된 구간까지만)'}</Text>
            {map.skipped ? <Text style={s.mapSkipped}>구간이 없는 버전 {map.skipped}개는 맵에서 제외했습니다 — 어느 부분인지 알 수 없어 크레딧을 배정할 수 없습니다.</Text> : null}
            <View style={s.shareList}>{map.shares.map(item => <View key={item.name} style={s.shareRow}>
              <View style={[s.shareDot, { backgroundColor: item.color }]}/>
              <Text style={s.shareName}>{item.name}</Text>
              <View style={s.grow}/>
              <Text style={s.shareCount}>{fmtSpan(item.total)}</Text>
              <Text style={s.sharePct}>{item.percent}%</Text>
            </View>)}</View>
          </View>

          <Text style={s.section}>반영 흐름</Text>
          <View style={s.flowCard}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.flowInner}>
              {(versions?.main ?? []).map((item, index) => <View key={item.id} style={s.flowStep}>
                {index > 0 ? <View style={s.flowArrow}>
                  <Text style={s.flowArrowLine}>──▶</Text>
                  <Text style={s.flowArrowLabel} numberOfLines={1}>{item.decidedByName && item.decidedByName !== item.authorName ? `${item.decidedByName} 반영` : '본인 반영'}</Text>
                </View> : null}
                <View style={[s.flowNode, { borderColor: map.colorOf(item.authorName) }, index === (versions?.main.length ?? 0) - 1 && s.flowNodeHead]}>
                  <Text style={[s.flowVer, { color: map.colorOf(item.authorName) }]}>v{item.number}</Text>
                  <Text style={s.flowSeg}>{item.segment}</Text>
                  <Text style={s.flowAuthor} numberOfLines={1}>{item.authorName}</Text>
                  {item.sourceSha256 ? <Text style={s.flowClip}>영상 {item.poseFrames ?? 0}f</Text> : <Text style={s.flowClipNone}>메모만</Text>}
                </View>
              </View>)}
            </ScrollView>
          </View>
          <Text style={s.countHint}>화살표에 적힌 사람이 그 버전을 main 에 반영한 사람입니다. 구간이 겹치면 나중에 반영된 쪽이 그 구간의 크레딧을 갖습니다.</Text>
        </>;
      })()}

      <Text style={s.section}>크레딧 미리보기</Text>
      <View style={s.creditCard}>
        <Text style={s.creditRoot}>{selected!.name}</Text>
        {flattenTree(creditTree()).map(({ key, prefix, cont, node }) => <View key={key} style={s.creditRow}>
          <Text style={s.creditBranch}>{prefix}{node.sub ? `\n${cont}` : ''}</Text>
          <View style={s.grow}>
            <Text style={[s.creditLabel, node.tone === 'accent' && s.creditAccent, node.tone === 'warn' && s.creditWarn,
              node.tone === 'muted' && s.creditMuted]}>{node.label}</Text>
            {node.sub ? <Text style={s.creditSub}>{node.sub}</Text> : null}
          </View>
        </View>)}
      </View>
      <Text style={s.countHint}>이 구조가 곧 기록입니다 — 원작에서 갈라진 버전과 구간별 기여가 그대로 크레딧이 됩니다.</Text>

      <Text style={s.section}>무엇이 남았나</Text>
      <RecordGroup title="01  안무의 시작" items={[
        `원작자 · ${selected!.ownerName}`,
        selected!.sourceSha256 ? `원본 영상 해시 · ${selected!.sourceSha256.slice(0, 12)}…` : '원본 영상 · 아직 없음',
        selected!.poseFrames ? `3D 포즈 · ${selected!.poseFrames} 프레임 · 33 랜드마크` : '3D 포즈 데이터 · 아직 없음',
        `기록 형식 · choreohub-motion-3d/v1`]}/>
      <RecordGroup title="02  함께 만든 사람" items={
        collaborators.length ? collaborators.map(item => `${item.name} · ${item.role} · ${item.counts} · ${item.permission}`)
                             : ['아직 초대한 사람이 없어요']}/>
      <RecordGroup title="03  공유 설정" items={[
        `공유 범위 · ${selected!.license}`,
        `초대 코드 · ${selected!.inviteCode}`,
        selected!.license === '연습 전용' ? '커뮤니티에 공개되지 않음' : '탐색 피드에 공개됨']}/>
      <RecordGroup title="04  버전 히스토리" items={
        chain.length ? chain.map(item => `v${item.number} · ${item.title} · ${item.segment} · ${item.authorName} · ${item.date}`)
                     : ['아직 버전이 없어요']}/>

      <Text style={s.section}>구간별 기여</Text>
      {covered.length ? covered.map(item => <View key={item.id} style={s.segRow}>
        <Text style={s.segTag}>{item.segment}</Text>
        <View style={s.grow}><Text style={s.versionTitle}>{item.title}</Text><Text style={s.meta}>v{item.number} · {item.authorName}</Text></View>
      </View>) : <Text style={s.meta}>구간을 지정한 버전이 아직 없어요. 수정 제안을 보낼 때 카운트를 적으면 여기에 모입니다.</Text>}

      <View style={s.passportWarning}>
        <Text style={s.passportWarningTitle}>춤은 이어지며 더 풍부해집니다</Text>
        <Text style={s.passportWarningCopy}>이 카드는 원작과 새로운 아이디어가 만난 과정을 정리한 작업 기록입니다. 법적 판정이나 권리 등록이 아니라, 누가 언제 어느 구간을 만들었는지를 남기는 것이 목적입니다.</Text>
      </View>
    </ScrollView><Bottom page="library" go={navTo} plus={()=>setModal(true)}/></SafeAreaView>;
  };
  const RecordGroup = ({title,items}:{title:string;items:string[]}) => <View style={s.recordGroup}><Text style={s.recordGroupTitle}>{title}</Text>{items.map(item=><View key={item} style={s.recordItem}><Text style={s.recordCheck}>✓</Text><Text style={s.recordItemText}>{item}</Text><Text style={s.recordArrow}>›</Text></View>)}</View>;
  const LicenseSettings = () => <SafeAreaView style={s.safe}><Header title="라이선스 설정" back={()=>go('profile')}/><ScrollView contentContainerStyle={s.content}><Text style={s.eyebrow}>DEFAULT PERMISSION</Text><Text style={s.title}>내 안무를 어떻게{`\n`}사용할 수 있나요?</Text>{(Object.keys(licenseColor) as License[]).map(item=><Pressable key={item} style={[s.license,license===item&&s.licenseOn]} onPress={()=>setLicense(item)}><View style={[s.radio,license===item&&{borderColor:licenseColor[item]}]}>{license===item&&<View style={[s.radioIn,{backgroundColor:licenseColor[item]}]}/>}</View><View style={s.grow}><Text style={s.licenseName}>{item}</Text><Text style={s.licenseCopy}>{item==='연습 전용'?'개인 열람과 연습만 허용합니다.':item==='비상업 커버 허용'?'출처 표기 시 비상업 영상 게시가 가능합니다.':item==='리믹스 허용'?'Fork와 2차 창작을 허용합니다.':'공연·광고·교육 사용 전 승인이 필요합니다.'}</Text></View></Pressable>)}<Pressable style={s.primary} onPress={()=>{notify('저장 완료', `${license}으로 기본 라이선스를 설정했습니다.`, 'ok');go('profile');}}><Text style={s.primaryText}>기본 설정 저장</Text></Pressable></ScrollView><Bottom page="profile" go={navTo} plus={()=>setModal(true)}/></SafeAreaView>;
  const pages: Record<Page,()=>React.JSX.Element> = { home:Home,library:Library,new:New,capture:Capture,version:Version,overlay:Overlay,data:Data,analysis:Analysis,motion:Motion,collab:Collab,perform:Perform,profile:Profile,community:CommunityPage,license:LicenseSettings,passport:Passport }; // 페이지를 요소(<Current/>)가 아니라 함수 호출로 그린다.
  // 이 화살표 함수들은 App 리렌더마다 새로 만들어져 요소로 쓰면 타입이 매번 바뀌고,
  // React 가 트리를 통째로 remount 한다 — 진행률 폴링(600ms)마다 영상이 처음으로
  // 되감기는 원인이었다. 함수 호출은 JSX 를 App 의 트리에 그대로 펼치므로
  // <video> 가 유지된다. (페이지 컴포넌트들은 훅을 쓰지 않아 안전하다.)
  const SignIn = () => <SafeAreaView style={s.safe}><ScrollView contentContainerStyle={s.content}>
    <Text style={s.kicker}>CHOREO / HUB</Text>
    <Text style={s.editorialTitle}>함께 만든 안무를{`\n`}함께 기록하세요</Text>
    <Text style={s.intro}>다른 참여자에게 보일 이름을 정해 주세요. 이 이름으로 초대받고, 기여 구간이 작업 기록에 남습니다.</Text>
    <Text style={s.label}>표시 이름</Text>
    <TextInput placeholder="예: 문지성" placeholderTextColor="#6E7C86" value={signInName} onChangeText={setSignInName} onSubmitEditing={signIn} style={s.input}/>
    {serverError ? <Text style={s.notice}>{serverError}</Text> : null}
    <Pressable style={[s.primary, busy && s.primaryDisabled]} onPress={signIn}><Text style={s.primaryText}>{busy ? '연결 중…' : '시작하기'}</Text></Pressable>
    <Text style={s.signInNote}>비밀번호는 없습니다. 이 기기에 이름이 저장되고, 초대 코드로 다른 사람의 작업에 참여할 수 있어요.</Text>
  </ScrollView></SafeAreaView>;

  // 로그인 화면과 본 화면이 서로 다른 return 이라, 토스트를 한쪽에만 두면 로그인 단계의
  // 안내가 사라진다.
  const ToastCard = () => (toast ? <Pressable style={[s.toast, toast.kind === 'ok' && s.toastOk]} onPress={() => setToast(null)}>
      <Text style={[s.toastTitle, toast.kind === 'ok' && s.toastTitleOk]}>{toast.title}</Text>
      {toast.body ? <Text style={s.toastBody}>{toast.body}</Text> : null}
    </Pressable> : null);

  // 시트가 열려 있으면 시트 안 카드만 보여 준다 — 둘이 겹쳐 보이지 않게.
  const sheetOpen = proposeOpen || editOpen || !!collabEditing || modal;
  const Toast = () => (toast && !sheetOpen ? <View style={s.toastWrap} pointerEvents="box-none">{ToastCard()}</View> : null);

  // RNW Modal 은 document.body 로 포털된다 — 떠 있는 토스트는 시트에 가려진다.
  // 그래서 시트 안에도 같은 카드를 넣는다.
  const SheetToast = () => (toast ? <View style={s.toastInline}>{ToastCard()}</View> : null);

  // 프로젝트가 있어야 열리는 화면들. 참여 중인 작업이 없으면 목록으로 돌린다.
  const needsProject: Page[] = ['version', 'overlay', 'data', 'collab'];
  if (!me) return <View style={s.app}><StatusBar style="light"/>{SignIn()}{Toast()}</View>;
  const active: Page = needsProject.includes(page) && !selected ? 'library' : page;
  return <View style={s.app}><StatusBar style="light"/>{pages[active]()}{CreateModal()}{CollabSheet()}{ProposeSheet()}{EditPostSheet()}{Toast()}</View>;
}

const s: any = StyleSheet.create({
 app:{flex:1,backgroundColor: '#0E1317'},safe:{flex:1,backgroundColor: '#0E1317'},content:{padding:22,paddingBottom:110},grow:{flex:1},header:{height:58,paddingHorizontal:22,flexDirection:'row',alignItems:'center',justifyContent:'space-between'},headerTitle:{color: '#E8EDF2',fontSize:16,fontWeight:'800',letterSpacing:-.4},headerGap:{width:22},back:{color: '#E8EDF2',fontSize:36,lineHeight:36},more:{color: '#A2AFB9',fontSize:15,letterSpacing:1},tabs:{flexDirection:'row',gap:22,marginBottom:16},tab:{paddingBottom:10,borderBottomWidth:2,borderBottomColor:'transparent'},tabOn:{borderBottomColor:PURPLE},tabText:{color: '#A2AFB9',fontSize:14,fontWeight:'600'},tabTextOn:{color:PURPLE},project:{minHeight:76,backgroundColor: '#181F26',borderWidth:1,borderColor: '#2A333B',borderRadius:16,padding:13,marginBottom:10,flexDirection:'row',alignItems:'center',gap:12},mark:{borderRadius:12,alignItems:'center',justifyContent:'center',flexDirection:'row',gap:3,paddingHorizontal:8,overflow:'hidden'},projectName:{color: '#E8EDF2',fontSize:15,fontWeight:'800',marginBottom:3},meta:{color: '#A2AFB9',fontSize:12,marginTop:2},right:{alignItems:'flex-end',gap:9},dotMenu:{color: '#8B99A3',fontSize:18,lineHeight:12},pill:{paddingHorizontal:9,paddingVertical:5,borderRadius:99},pillText:{fontSize:10,fontWeight:'800'},passport:{marginTop:16,backgroundColor: '#0A0F14',borderRadius:18,padding:17,flexDirection:'row',alignItems:'center',gap:12},passIcon:{color: '#E0AE3C',fontSize:20},passTitle:{color: '#E8EDF2',fontSize:14,fontWeight:'800'},passSub:{color: '#A2AFB9',fontSize:12,marginTop:4},chev:{color:PURPLE,fontSize:25,marginLeft:'auto'},bottom:{height:78,backgroundColor: '#181F26',borderTopColor: '#222A31',borderTopWidth:1,paddingHorizontal:12,flexDirection:'row',justifyContent:'space-around',alignItems:'center'},nav:{alignItems:'center',width:52,gap:3},navIcon:{color: '#A2AFB9',fontSize:22},navLabel:{color: '#A2AFB9',fontSize:10},navPlusIcon:{color:'#FFFFFF',fontWeight:'900'},active:{color:PURPLE},navPlus:{width:44,height:44,borderRadius:22,backgroundColor: '#E4573E',alignItems:'center',justifyContent:'center',marginTop:-18,shadowColor: '#FF8B77',shadowOpacity:.25,shadowRadius:14,elevation:5},eyebrow:{color:PURPLE,fontSize:11,fontWeight:'800',letterSpacing:1.3,marginBottom:10},title:{color: '#E8EDF2',fontSize:27,lineHeight:35,fontWeight:'800',marginBottom:26},upload:{alignItems:'center',padding:30,backgroundColor: '#181F26',borderWidth:1,borderStyle:'dashed',borderColor: '#2A333B',borderRadius:22,marginBottom:18},uploadIcon:{color:PURPLE,fontSize:30,marginBottom:10},uploadTitle:{color: '#E8EDF2',fontSize:16,fontWeight:'700'},uploadCopy:{color: '#A2AFB9',fontSize:12,lineHeight:18,textAlign:'center',marginTop:7,marginBottom:18},outline:{borderWidth:1,borderColor:PURPLE,borderRadius:11,paddingHorizontal:16,paddingVertical:10},outlineText:{color:PURPLE,fontWeight:'700',fontSize:13},step:{flexDirection:'row',alignItems:'center',paddingVertical:15,borderBottomWidth:1,borderBottomColor: '#222A31'},stepNo:{color:PURPLE,fontSize:13,fontWeight:'800',width:40},primary:{marginTop:26,height:54,borderRadius:15,backgroundColor:PURPLE,alignItems:'center',justifyContent:'center'},primaryText:{color: '#0B1116',fontSize:15,fontWeight:'800'},hero:{backgroundColor: '#1B2740',borderRadius:22,padding:20,flexDirection:'row',justifyContent:'space-between',alignItems:'center'},heroTitle:{color: '#E8EDF2',fontSize:27,fontWeight:'800'},owner:{paddingVertical:19,flexDirection:'row',alignItems:'center',gap:10},avatar:{width:36,height:36,borderRadius:18,backgroundColor: '#1B2740',alignItems:'center',justifyContent:'center'},avatarText:{color:PURPLE,fontSize:11,fontWeight:'800'},ownerName:{color: '#E8EDF2',fontSize:14,fontWeight:'700'},section:{color: '#E8EDF2',fontSize:16,fontWeight:'800',marginTop:12,marginBottom:12},versionRow:{minHeight:63,backgroundColor: '#181F26',borderWidth:1,borderColor: '#2A333B',borderRadius:14,padding:12,flexDirection:'row',alignItems:'center',gap:10,marginBottom:8},status:{width:10,height:10,borderRadius:5},versionTitle:{color: '#E8EDF2',fontSize:13,fontWeight:'700'},grid:{flexDirection:'row',flexWrap:'wrap',gap:10,marginTop:16},action:{width:'47.8%',height:94,borderRadius:16,backgroundColor: '#181F26',borderWidth:1,borderColor: '#2A333B',padding:14,justifyContent:'space-between'},actionIcon:{color:PURPLE,fontSize:23},actionText:{color: '#E8EDF2',fontSize:13,fontWeight:'700'},scoreCard:{borderRadius:22,padding:22,backgroundColor: '#0A0F14'},scoreLabel:{color: '#7FA5FF',fontWeight:'700',fontSize:13},score:{color: '#FFFFFF',fontSize:58,fontWeight:'800',marginTop:6},scoreUnit:{fontSize:25,color: '#7FA5FF'},track:{height:6,backgroundColor: '#2A333B',borderRadius:3,marginTop:18,overflow:'hidden'},fill:{height:'100%',width:'87%',backgroundColor: '#E0AE3C',borderRadius:3},analysis:{flexDirection:'row',alignItems:'center',backgroundColor: '#181F26',borderRadius:15,padding:15,gap:12,marginBottom:9,borderWidth:1,borderColor: '#2A333B'},count:{color:PURPLE,fontSize:10,fontWeight:'800',letterSpacing:1},analysisCopy:{color: '#E8EDF2',fontSize:13,marginTop:5},secondary:{height:50,borderRadius:14,borderWidth:1,borderColor:PURPLE,justifyContent:'center',alignItems:'center',marginTop:8},secondaryText:{color:PURPLE,fontSize:14,fontWeight:'800'},stage:{height:335,borderRadius:22,overflow:'hidden',backgroundColor: '#0A0F14',justifyContent:'center',alignItems:'center'},stageTag:{position:'absolute',top:16,left:16,color: '#E8EDF2',fontWeight:'800',fontSize:11,letterSpacing:1,backgroundColor: '#E0AE3C',paddingHorizontal:10,paddingVertical:6,borderRadius:8},skeleton:{color: '#7FA5FF',fontSize:60,lineHeight:62,textAlign:'center'},joint:{position:'absolute',right:16,bottom:24,backgroundColor: '#181F26',borderRadius:12,padding:11},jointName:{color: '#A2AFB9',fontSize:11},jointValue:{color:PURPLE,fontSize:19,fontWeight:'800',marginTop:3},tip:{backgroundColor: '#181F26',borderRadius:16,padding:15,flexDirection:'row',gap:13,marginBottom:10,borderWidth:1,borderColor: '#2A333B'},tipIndex:{color:PURPLE,fontWeight:'900',fontSize:16},tipTitle:{color: '#E8EDF2',fontSize:14,fontWeight:'700'},tipCopy:{color: '#A2AFB9',fontSize:12,lineHeight:18,marginTop:6,paddingRight:10},summary:{flexDirection:'row',alignItems:'baseline',gap:7,padding:18,borderRadius:17,backgroundColor: '#12291F',marginBottom:18},summaryNumber:{color: '#4FC7A2',fontSize:25,fontWeight:'800'},summaryCopy:{color: '#4FC7A2',fontSize:11,marginRight:8},request:{padding:15,borderRadius:18,backgroundColor: '#181F26',borderWidth:1,borderColor: '#2A333B',flexDirection:'row',gap:12,marginBottom:10},link:{color:PURPLE,fontSize:12,fontWeight:'800',marginTop:11},perform:{flex:1},performStage:{flex:1,backgroundColor: '#0A0F14',alignItems:'center',justifyContent:'center',overflow:'hidden'},stageGrid:{color: '#8B99A3',fontSize:42,lineHeight:40,textAlign:'center',position:'absolute'},avatar3d:{color: '#7FA5FF',fontSize:88,lineHeight:90,textAlign:'center'},play:{position:'absolute',bottom:26,width:54,height:54,borderRadius:27,backgroundColor: '#E4573E',alignItems:'center',justifyContent:'center'},playText:{color: '#FFFFFF',marginLeft:3},player:{padding:22,backgroundColor: '#181F26'},timeline:{height:5,borderRadius:3,backgroundColor: '#2A333B',marginTop:16},timeFill:{width:'45%',height:'100%',borderRadius:3,backgroundColor:PURPLE},controls:{color: '#E8EDF2',fontSize:22,textAlign:'center',marginTop:18},profile:{alignItems:'center',paddingTop:10,paddingBottom:22},profileAvatar:{width:78,height:78,borderRadius:39,backgroundColor: '#E4573E',alignItems:'center',justifyContent:'center',borderWidth:3,borderColor: '#4D4020'},profileInitial:{color: '#FFFFFF',fontWeight:'800',fontSize:21},profileName:{color: '#E8EDF2',fontWeight:'800',fontSize:21,marginTop:12},stats:{backgroundColor: '#181F26',borderRadius:18,padding:18,flexDirection:'row',justifyContent:'space-around',marginBottom:20,borderWidth:1,borderColor: '#2A333B'},statNum:{color:PURPLE,fontSize:20,fontWeight:'800',textAlign:'center'},statLabel:{color: '#A2AFB9',fontSize:11,marginTop:5},setting:{borderRadius:16,padding:16,backgroundColor: '#181F26',flexDirection:'row',alignItems:'center',gap:13,borderWidth:1,borderColor: '#2A333B'},settingIcon:{color:PURPLE,fontSize:21},license:{flexDirection:'row',gap:13,padding:15,borderRadius:16,backgroundColor: '#181F26',borderWidth:1,borderColor:'transparent',marginBottom:10},licenseOn:{borderColor:PURPLE,backgroundColor: '#1B2740'},radio:{width:20,height:20,borderRadius:10,borderWidth:2,borderColor: '#2A333B',alignItems:'center',justifyContent:'center',marginTop:2},radioIn:{width:10,height:10,borderRadius:5},licenseName:{color: '#E8EDF2',fontSize:14,fontWeight:'800'},licenseCopy:{color: '#A2AFB9',fontSize:12,lineHeight:17,marginTop:5,paddingRight:12},overlay:{flex:1,backgroundColor: 'rgba(0,0,0,.66)',justifyContent:'flex-end'},sheet:{backgroundColor: '#181F26',borderTopLeftRadius:26,borderTopRightRadius:26,padding:22,paddingBottom:40,maxHeight:'90%'},handle:{width:38,height:4,borderRadius:2,backgroundColor: '#8B99A3',alignSelf:'center',marginBottom:20},sheetTitle:{color: '#E8EDF2',fontSize:20,fontWeight:'800',marginBottom:22},label:{color: '#A2AFB9',fontSize:12,fontWeight:'700',marginBottom:8,marginTop:13},input:{backgroundColor: '#131A20',borderColor: '#2A333B',borderWidth:1,color: '#E8EDF2',paddingHorizontal:14,height:49,borderRadius:12},kicker:{fontSize:10,fontWeight:'800',letterSpacing:1.4,color:PURPLE,marginTop:12},editorialTitle:{fontSize:38,lineHeight:43,letterSpacing:-1.5,fontWeight:'900',color: '#E8EDF2',marginTop:8},intro:{fontSize:14,lineHeight:21,color: '#A2AFB9',marginTop:13,marginBottom:24,maxWidth:310},feature:{backgroundColor:'#1B2740',borderWidth:1,borderColor:'#33456B',borderRadius:24,padding:20,overflow:'hidden'},featureTop:{flexDirection:'row',justifyContent:'space-between',alignItems:'center'},featureLabel:{fontSize:10,fontWeight:'800',letterSpacing:1,color:'#9DB8F5'},featureArrow:{fontSize:22,color:'#E8EDF2'},featureTitle:{fontSize:28,fontWeight:'900',letterSpacing:-.8,color:'#E8EDF2',marginTop:16},wave:{height:66,marginVertical:10,position:'relative',justifyContent:'center'},waveCircle:{width:54,height:54,borderRadius:27,borderWidth:1,borderColor: '#7FA5FF',position:'absolute',left:5},waveLine:{height:2,width:'68%',backgroundColor: '#7FA5FF',position:'absolute',left:45,transform:[{rotate:'-12deg'}]},waveLineShort:{height:2,width:'27%',backgroundColor: '#E0AE3C',position:'absolute',right:0,transform:[{rotate:'18deg'}]},waveDot:{width:12,height:12,borderRadius:6,backgroundColor: '#E0AE3C',position:'absolute',left:'55%',top:10},featureBottom:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:8},featureCopy:{fontSize:11,color:'#A2AFB9',flex:1},rowHeading:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginTop:28,marginBottom:11},sectionInk:{fontSize:18,fontWeight:'900',letterSpacing:-.4,color: '#E8EDF2'},seeAll:{fontSize:12,fontWeight:'800',color:PURPLE},checkCard:{backgroundColor:'#2A2314',borderWidth:1,borderColor:'#4D4020',borderRadius:18,padding:16,flexDirection:'row',gap:12,alignItems:'center'},checkIcon:{width:42,height:42,borderRadius:21,backgroundColor:'#E0AE3C',alignItems:'center',justifyContent:'center'},checkIconText:{fontSize:23,color:'#2A2314'},checkTitle:{fontSize:15,fontWeight:'900',color:'#E7C77A'},checkCopy:{fontSize:12,lineHeight:17,color:'#A2AFB9',marginTop:4}
});

Object.assign(s, {
  uploadedCard: { minHeight: 86, backgroundColor: '#181F26', borderWidth: 1, borderColor: '#2A333B', borderRadius: 18, padding: 14, marginBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 12 },
  uploadedMeta: { fontSize: 11, color: '#4FC7A2', marginTop: 7, fontWeight: '700' },
  videoStage: { height: 310, backgroundColor: '#0A0F14', borderRadius: 22, overflow: 'hidden' },
  video: { width: '100%', height: '100%' },
  videoPlaceholder: { height: 310, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0A0F14', padding: 26 },
  videoPlaceholderIcon: { color: '#E0AE3C', fontSize: 42 },
  videoPlaceholderTitle: { color: '#FFFFFF', fontWeight: '900', fontSize: 16, textAlign: 'center', marginTop: 12 },
  videoPlaceholderCopy: { color: '#A2AFB9', textAlign: 'center', fontSize: 12, lineHeight: 18, marginTop: 8 },
  mediaInfo: { paddingTop: 20 },
  mediaTitle: { color: '#E8EDF2', fontWeight: '900', fontSize: 24, marginTop: -2 },
  dataSummary: { marginTop: 18, backgroundColor: '#12291F', borderRadius: 18, padding: 18, flexDirection: 'row', alignItems: 'center', gap: 12 },
  dataSummaryNumber: { color: '#4FC7A2', fontSize: 28, fontWeight: '900' },
  dataSummaryCopy: { color: '#4FC7A2', fontSize: 12, lineHeight: 18, fontWeight: '700' },
  jobCard: { marginTop: 14, backgroundColor: '#181F26', borderWidth: 1, borderColor: '#33456B', borderRadius: 16, padding: 15 },
  jobCardDone: { borderColor: '#255544', backgroundColor: '#12291F' },
  jobHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  jobTitle: { color: '#E8EDF2', fontSize: 14, fontWeight: '800' },
  jobPercent: { color: PURPLE, fontSize: 14, fontWeight: '900', fontVariant: ['tabular-nums'] },
  jobPercentDone: { color: '#4FC7A2' },
  jobTrack: { height: 6, borderRadius: 3, backgroundColor: '#131A20', overflow: 'hidden' },
  jobFill: { height: '100%', borderRadius: 3, backgroundColor: PURPLE },
  jobFillDone: { backgroundColor: '#4FC7A2' },
  jobCopy: { color: '#A2AFB9', fontSize: 12, lineHeight: 18, marginTop: 9 },
  jobHint: { color: '#E0AE3C', fontSize: 12, lineHeight: 18, marginTop: 7, fontWeight: '700' },
  jobRetry: { color: PURPLE, fontSize: 12, fontWeight: '900' },
  assetRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 11 },
  assetName: { flex: 1, color: '#A2AFB9', fontSize: 12 },
  assetChange: { color: PURPLE, fontSize: 12, fontWeight: '900' },
  primaryPending: { backgroundColor: '#4A6BA8' },
  danger: { marginTop: 10, height: 48, borderRadius: 14, borderWidth: 1, borderColor: '#5C332C', alignItems: 'center', justifyContent: 'center' },
  dangerText: { color: '#FF8B77', fontSize: 13, fontWeight: '800' },
  linkName: { color: PURPLE },
  ghFollowRow: { flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 14 },
  ghFollowStat: { color: '#A2AFB9', fontSize: 13 },
  ghFollowNum: { color: '#E8EDF2', fontWeight: '900' },
  followBtn: { marginLeft: 'auto', paddingHorizontal: 18, paddingVertical: 9, borderRadius: 11, backgroundColor: PURPLE },
  followBtnOn: { backgroundColor: '#181F26', borderWidth: 1, borderColor: '#2A333B' },
  followBtnText: { color: '#0B1116', fontSize: 13, fontWeight: '800' },
  followBtnTextOn: { color: '#A2AFB9' },
  personRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#181F26', borderWidth: 1, borderColor: '#2A333B', borderRadius: 14, padding: 12, marginBottom: 8 },
  personAvatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#1B2740', alignItems: 'center', justifyContent: 'center' },
  personAvatarText: { color: PURPLE, fontWeight: '900', fontSize: 13 },
  feedCard: { backgroundColor: '#181F26', borderWidth: 1, borderColor: '#2A333B', borderRadius: 16, padding: 14, marginBottom: 9 },
  feedOwner: { color: PURPLE, fontSize: 12, fontWeight: '800', marginTop: 3 },
  ghHead: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 6 },
  ghAvatar: { width: 68, height: 68, borderRadius: 34, backgroundColor: '#0A0F14', alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: '#4D4020' },
  ghAvatarText: { color: '#E0AE3C', fontWeight: '900', fontSize: 22 },
  ghName: { color: '#E8EDF2', fontWeight: '900', fontSize: 22, letterSpacing: -.5 },
  ghHandle: { color: PURPLE, fontSize: 13, fontWeight: '800', marginTop: 1 },
  ghJoined: { color: '#A2AFB9', fontSize: 12, marginTop: 5 },
  ghStats: { flexDirection: 'row', backgroundColor: '#181F26', borderWidth: 1, borderColor: '#2A333B', borderRadius: 16, paddingVertical: 15, marginTop: 18 },
  ghStat: { flex: 1, alignItems: 'center' },
  ghStatNum: { color: '#E8EDF2', fontSize: 19, fontWeight: '900', fontVariant: ['tabular-nums'] },
  ghStatLabel: { color: '#A2AFB9', fontSize: 11, marginTop: 4 },
  ghGraphCard: { backgroundColor: '#181F26', borderWidth: 1, borderColor: '#2A333B', borderRadius: 16, padding: 14 },
  ghGraphInner: { paddingBottom: 4 },
  ghMonthRow: { height: 16, position: 'relative' },
  ghMonth: { position: 'absolute', top: 0, color: '#8B99A3', fontSize: 9.5, fontWeight: '700' },
  ghWeeks: { flexDirection: 'row', gap: 3 },
  ghWeek: { gap: 3 },
  ghCell: { width: 11, height: 11, borderRadius: 2.5 },
  ghLegend: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 12, justifyContent: 'flex-end' },
  ghLegendText: { color: '#8B99A3', fontSize: 10.5, marginHorizontal: 3 },
  ghPin: { backgroundColor: '#181F26', borderWidth: 1, borderColor: '#2A333B', borderRadius: 16, padding: 14, marginBottom: 9 },
  ghPinTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  ghPinBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  ghPinRole: { color: '#A2AFB9', fontSize: 11, fontWeight: '800' },
  ghActivity: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: '#222A31' },
  ghDot: { width: 8, height: 8, borderRadius: 4 },
  ghActivityDate: { color: '#8B99A3', fontSize: 11, fontVariant: ['tabular-nums'] },
  dangerZone: { marginTop: 26, borderWidth: 1, borderColor: '#5C332C', borderRadius: 14, padding: 15, backgroundColor: '#2E1A17' },
  dangerZoneTitle: { color: '#FF8B77', fontSize: 14, fontWeight: '900' },
  dangerZoneCopy: { color: '#C9A79F', fontSize: 12, lineHeight: 18, marginTop: 7 },
  editRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#181F26', borderWidth: 1, borderColor: '#33456B', borderRadius: 14, padding: 13, marginTop: 12 },
  editIcon: { color: PURPLE, fontSize: 18, width: 22, textAlign: 'center' },
  editTitle: { color: '#E8EDF2', fontSize: 14, fontWeight: '800' },
  mapCard: { backgroundColor: '#181F26', borderWidth: 1, borderColor: '#2A333B', borderRadius: 16, padding: 16 },
  mapBar: { flexDirection: 'row', height: 38, borderRadius: 9, overflow: 'hidden', gap: 2 },
  mapBlock: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 2 },
  mapBlockText: { color: '#0B1116', fontSize: 10.5, fontWeight: '800' },
  mapTicks: { flexDirection: 'row', marginTop: 6 },
  mapTick: { color: '#8B99A3', fontSize: 10, textAlign: 'right', fontVariant: ['tabular-nums'] },
  required: { color: '#FF8B77', fontSize: 11, fontWeight: '800' },
  versionActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  clipBanner: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#1B2740', borderWidth: 1, borderColor: '#33456B', borderRadius: 14, padding: 13, marginBottom: 13 },
  clipBannerTitle: { color: '#E8EDF2', fontSize: 14, fontWeight: '800' },
  clipBannerMeta: { color: '#A2AFB9', fontSize: 12, marginTop: 4 },
  clipBannerBtn: { borderWidth: 1, borderColor: '#7FA5FF', borderRadius: 9, paddingHorizontal: 12, paddingVertical: 8 },
  clipBannerBtnText: { color: '#7FA5FF', fontSize: 12, fontWeight: '800' },
  headBtn: { marginTop: 12, alignSelf: 'flex-start', borderWidth: 1, borderColor: '#33456B', borderRadius: 9, paddingHorizontal: 12, paddingVertical: 7 },
  headBtnText: { color: '#7FA5FF', fontSize: 12, fontWeight: '800' },
  growHint: { color: '#4FC7A2', fontSize: 11.5, lineHeight: 17, marginTop: 7, fontWeight: '700' },
  mapSkipped: { color: '#E0AE3C', fontSize: 11.5, lineHeight: 17, marginTop: 7 },
  mapAxis: { color: '#A2AFB9', fontSize: 11.5, marginTop: 8 },
  shareList: { marginTop: 14, gap: 9 },
  shareRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  shareDot: { width: 10, height: 10, borderRadius: 5 },
  shareName: { color: '#E8EDF2', fontSize: 13, fontWeight: '700' },
  shareCount: { color: '#A2AFB9', fontSize: 11.5, fontVariant: ['tabular-nums'] },
  sharePct: { color: '#E8EDF2', fontSize: 12.5, fontWeight: '800', width: 42, textAlign: 'right', fontVariant: ['tabular-nums'] },
  flowCard: { backgroundColor: '#181F26', borderWidth: 1, borderColor: '#2A333B', borderRadius: 16, paddingVertical: 15 },
  flowInner: { paddingHorizontal: 15, alignItems: 'center' },
  flowStep: { flexDirection: 'row', alignItems: 'center' },
  flowArrow: { width: 84, alignItems: 'center' },
  flowArrowLine: { color: '#8B99A3', fontSize: 13 },
  flowArrowLabel: { color: '#8B99A3', fontSize: 10, marginTop: 3, maxWidth: 80, textAlign: 'center' },
  flowNode: { width: 124, borderWidth: 1.5, borderRadius: 13, padding: 11, backgroundColor: '#1B2740' },
  flowNodeHead: { backgroundColor: '#1B2740' },
  flowVer: { fontSize: 12.5, fontWeight: '900', fontFamily: Platform.OS === 'web' ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'Menlo' },
  flowSeg: { color: '#E8EDF2', fontSize: 12, fontWeight: '800', marginTop: 5 },
  flowAuthor: { color: '#A2AFB9', fontSize: 11.5, marginTop: 4 },
  flowClip: { color: '#4FC7A2', fontSize: 10.5, fontWeight: '800', marginTop: 6 },
  flowClipNone: { color: '#8B99A3', fontSize: 10.5, marginTop: 6 },
  creditCard: { backgroundColor: '#181F26', borderWidth: 1, borderColor: '#2A333B', borderRadius: 16, padding: 16, marginTop: 4 },
  creditRoot: { color: '#E8EDF2', fontSize: 15, fontWeight: '900', marginBottom: 10 },
  creditRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 2 },
  creditBranch: { color: '#8B99A3', fontSize: 12.5, lineHeight: 20, fontFamily: Platform.OS === 'web' ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'Menlo' },
  creditLabel: { color: '#E8EDF2', fontSize: 13, fontWeight: '700', lineHeight: 20 },
  creditAccent: { color: PURPLE, fontWeight: '800' },
  creditWarn: { color: '#E0AE3C' },
  creditMuted: { color: '#8B99A3' },
  creditSub: { color: '#A2AFB9', fontSize: 11.5, lineHeight: 20 },
  recordStats: { flexDirection: 'row', backgroundColor: '#181F26', borderWidth: 1, borderColor: '#2A333B', borderRadius: 16, paddingVertical: 15, marginTop: 14 },
  recordStat: { flex: 1, alignItems: 'center' },
  recordStatNum: { color: '#E8EDF2', fontSize: 19, fontWeight: '900', fontVariant: ['tabular-nums'] },
  recordStatLabel: { color: '#A2AFB9', fontSize: 11, marginTop: 4 },
  segRow: { flexDirection: 'row', alignItems: 'center', gap: 11, backgroundColor: '#181F26', borderWidth: 1, borderColor: '#2A333B', borderRadius: 13, padding: 12, marginBottom: 8 },
  // RNW Modal 은 zIndex 9999 로 깔린다. 시트 위에서도 안내가 보여야 하므로 그보다 높인다.
  toastInline: { marginBottom: 14 },
  // 시트 안에는 SheetToast 가 따로 뜨므로, 떠 있는 쪽은 헤더를 가리지 않게 하단에 둔다
  toastWrap: { position: 'absolute', left: 16, right: 16, bottom: 92, alignItems: 'center', zIndex: 10000 },
  toast: { maxWidth: 460, width: '100%', backgroundColor: '#0A0F14', borderRadius: 14, paddingHorizontal: 16, paddingVertical: 13, borderLeftWidth: 4, borderLeftColor: '#FF8B77' },
  toastOk: { borderLeftColor: '#4FC7A2' },
  toastTitle: { color: '#FF8B77', fontSize: 14, fontWeight: '800' },
  toastTitleOk: { color: '#4FC7A2' },
  toastBody: { color: '#A2AFB9', fontSize: 12.5, lineHeight: 18, marginTop: 5 },
  clipTag: { fontSize: 10, fontWeight: '800', color: '#4FC7A2', backgroundColor: '#12291F', paddingHorizontal: 6, paddingVertical: 3, borderRadius: 5 },
  attachPick: { borderWidth: 1, borderStyle: 'dashed', borderColor: '#2A333B', borderRadius: 12, padding: 14, backgroundColor: '#131A20' },
  attachPickText: { color: PURPLE, fontSize: 13.5, fontWeight: '800' },
  attachPickNote: { color: '#A2AFB9', fontSize: 11.5, lineHeight: 17, marginTop: 6 },
  attachCard: { borderWidth: 1, borderColor: '#33456B', borderRadius: 12, padding: 13, backgroundColor: '#181F26' },
  attachTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  attachName: { flex: 1, color: '#E8EDF2', fontSize: 12.5, fontWeight: '700' },
  attachClear: { color: '#FF8B77', fontSize: 12, fontWeight: '800' },
  attachTrack: { height: 5, borderRadius: 3, backgroundColor: '#131A20', overflow: 'hidden', marginTop: 11 },
  attachFill: { height: '100%', borderRadius: 3, backgroundColor: PURPLE },
  attachFillDone: { backgroundColor: '#4FC7A2' },
  attachStage: { color: '#A2AFB9', fontSize: 11.5, marginTop: 7 },
  attachDone: { color: '#4FC7A2', fontSize: 11.5, fontWeight: '700', marginTop: 7 },
  attachError: { color: '#FF8B77', fontSize: 11.5, lineHeight: 17, marginTop: 9 },
  countRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  countInput: { flex: 1, textAlign: 'center' },
  countDash: { color: '#A2AFB9', fontSize: 16, fontWeight: '800' },
  countHint: { color: '#A2AFB9', fontSize: 11.5, lineHeight: 17, marginTop: 8 },
  inputMulti: { height: 88, paddingTop: 12, textAlignVertical: 'top' },
  segTag: { fontFamily: Platform.OS === 'web' ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'Menlo', fontSize: 10.5, fontWeight: '700', color: PURPLE, backgroundColor: '#1B2740', paddingHorizontal: 7, paddingVertical: 3, borderRadius: 5 },
  proposalCard: { backgroundColor: '#181F26', borderWidth: 1, borderColor: '#4D4020', borderRadius: 14, padding: 14, marginBottom: 9 },
  proposalTop: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 9 },
  proposalDate: { color: '#8B99A3', fontSize: 11, fontVariant: ['tabular-nums'] },
  proposalAuthor: { color: PURPLE, fontSize: 12, fontWeight: '800', marginTop: 4 },
  proposalNote: { color: '#A2AFB9', fontSize: 12.5, lineHeight: 19, marginTop: 8 },
  proposalActions: { flexDirection: 'row', gap: 8, marginTop: 13 },
  proposalWait: { color: '#E0AE3C', fontSize: 12, fontWeight: '700', marginTop: 11 },
  mergeBtn: { flex: 1, height: 44, borderRadius: 11, backgroundColor: '#4FC7A2', alignItems: 'center', justifyContent: 'center' },
  mergeBtnText: { color: '#0B1116', fontSize: 13, fontWeight: '800' },
  declineBtn: { height: 44, paddingHorizontal: 18, borderRadius: 11, borderWidth: 1, borderColor: '#5C332C', alignItems: 'center', justifyContent: 'center' },
  declineBtnText: { color: '#FF8B77', fontSize: 13, fontWeight: '800' },
  mainRow: { flexDirection: 'row', gap: 12 },
  mainRail: { width: 14, alignItems: 'center', paddingTop: 16 },
  mainDot: { width: 11, height: 11, borderRadius: 6, backgroundColor: '#2A333B' },
  mainDotHead: { backgroundColor: PURPLE, width: 13, height: 13, borderRadius: 7 },
  mainLine: { flex: 1, width: 2, backgroundColor: '#131A20', marginTop: 4 },
  mainCard: { flex: 1, backgroundColor: '#181F26', borderWidth: 1, borderColor: '#2A333B', borderRadius: 14, padding: 14, marginBottom: 9 },
  mainCardHead: { borderColor: '#33456B', backgroundColor: '#1B2740' },
  versionNo: { fontFamily: Platform.OS === 'web' ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'Menlo', fontSize: 11.5, fontWeight: '700', color: '#A2AFB9' },
  versionNoHead: { color: PURPLE },
  headTag: { fontSize: 9.5, fontWeight: '900', letterSpacing: 1, color: '#0B1116', backgroundColor: PURPLE, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 4 },
  mainMeta: { color: '#A2AFB9', fontSize: 12, marginTop: 5 },
  declinedRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#222A31' },
  declinedTitle: { color: '#A2AFB9', fontSize: 13 },
  activityText: { color: '#E8EDF2', fontSize: 13 },
  declinedMeta: { color: '#8B99A3', fontSize: 11.5 },
  formatRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 4 },
  formatBadge: { fontFamily: Platform.OS === 'web' ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'Menlo', fontSize: 11.5, fontWeight: '700', color: PURPLE, backgroundColor: '#1B2740', paddingHorizontal: 9, paddingVertical: 5, borderRadius: 6 },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#181F26', borderWidth: 1, borderColor: '#2A333B', borderRadius: 14, padding: 13, marginBottom: 8 },
  fileTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fileKind: { fontFamily: Platform.OS === 'web' ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'Menlo', fontSize: 10, fontWeight: '700', color: '#A2AFB9', backgroundColor: '#242E36', paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4, textTransform: 'uppercase' },
  fileLabel: { color: '#E8EDF2', fontSize: 14, fontWeight: '800', flexShrink: 1 },
  fileNote: { color: '#A2AFB9', fontSize: 12, lineHeight: 17, marginTop: 5 },
  fileSize: { color: '#8B99A3', fontSize: 11, marginTop: 5, fontVariant: ['tabular-nums'] },
  fileActions: { gap: 6 },
  fileBtn: { borderWidth: 1, borderColor: '#33456B', borderRadius: 9, paddingHorizontal: 12, paddingVertical: 7, alignItems: 'center' },
  fileBtnText: { color: PURPLE, fontSize: 12, fontWeight: '800' },
  blob: { backgroundColor: '#0A0F14', borderRadius: 14, overflow: 'hidden', marginBottom: 16 },
  blobHead: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#2A333B' },
  blobName: { color: '#E8EDF2', fontSize: 13, fontWeight: '800' },
  blobMeta: { color: '#8B99A3', fontSize: 11, marginTop: 3, fontVariant: ['tabular-nums'] },
  blobClose: { color: '#7FA5FF', fontSize: 12, fontWeight: '800' },
  blobScroll: { maxHeight: 340 },
  blobInner: { padding: 12 },
  codeRow: { flexDirection: 'row', gap: 12 },
  codeNum: { color: '#8B99A3', fontSize: 11, lineHeight: 18, width: 42, textAlign: 'right', fontVariant: ['tabular-nums'], fontFamily: Platform.OS === 'web' ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'Menlo' },
  codeText: { color: '#E8EDF2', fontSize: 11.5, lineHeight: 18, fontFamily: Platform.OS === 'web' ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'Menlo' },
  blobTrunc: { color: '#E0AE3C', fontSize: 11.5, lineHeight: 17, paddingHorizontal: 14, paddingBottom: 12 },
  blobDownload: { margin: 12, marginTop: 0, height: 44, borderRadius: 10, backgroundColor: PURPLE, alignItems: 'center', justifyContent: 'center' },
  blobDownloadText: { color: '#0B1116', fontSize: 13, fontWeight: '800' },
  joinCard: { backgroundColor: '#181F26', borderWidth: 1, borderColor: '#2A333B', borderRadius: 16, padding: 15, marginBottom: 16 },
  joinLabel: { color: '#A2AFB9', fontSize: 12, fontWeight: '800', marginBottom: 9 },
  joinRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  joinButton: { height: 49, paddingHorizontal: 20, borderRadius: 12, backgroundColor: PURPLE, alignItems: 'center', justifyContent: 'center' },
  joinButtonText: { color: '#0B1116', fontSize: 14, fontWeight: '800' },
  signInNote: { color: '#A2AFB9', fontSize: 12, lineHeight: 18, marginTop: 16 },
  sheetScroll: { flexGrow: 0 },
  sheetScrollInner: { paddingBottom: 8 },
  inviteCard: { marginTop: 6, backgroundColor: '#0A0F14', borderRadius: 18, padding: 18 },
  inviteLabel: { color: '#A2AFB9', fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  inviteCode: { color: '#E0AE3C', fontSize: 16, fontWeight: '900', marginTop: 7 },
  inviteCopy: { color: '#A2AFB9', fontSize: 12, lineHeight: 18, marginTop: 9 },
  invitePrimary: { marginTop: 15, height: 48, borderRadius: 13, backgroundColor: PURPLE, alignItems: 'center', justifyContent: 'center' },
  collabPermission: { color: '#A2AFB9', fontSize: 11, fontWeight: '800', marginTop: 6 },
  collabPermissionStrong: { color: '#4FC7A2' },
  emptyCard: { backgroundColor: '#181F26', borderWidth: 1, borderStyle: 'dashed', borderColor: '#2A333B', borderRadius: 16, padding: 20 },
  emptyTitle: { color: '#E8EDF2', fontSize: 14, fontWeight: '800' },
  emptyCopy: { color: '#A2AFB9', fontSize: 12, lineHeight: 18, marginTop: 7 },
  modeRow: { flexDirection: 'row', gap: 7, marginBottom: 13 },
  modeChip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 11, backgroundColor: '#181F26', borderWidth: 1, borderColor: '#2A333B' },
  modeChipOn: { backgroundColor: PURPLE, borderColor: PURPLE },
  modeChipOff: { opacity: .4 },
  modeChipText: { color: '#A2AFB9', fontSize: 13, fontWeight: '800' },
  modeChipTextOn: { color: '#0B1116' },
  skeletonBackdrop: { position: 'absolute', inset: 0, backgroundColor: 'rgba(6,10,14,.94)' },
  notice: { color: '#E0AE3C', backgroundColor: '#2A2314', borderRadius: 12, padding: 12, fontSize: 12, lineHeight: 18, fontWeight: '700' },
  motionOverlay: { position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' },
  landmarkDot: { position: 'absolute', width: 9, height: 9, borderRadius: 5, marginLeft: -4.5, marginTop: -4.5, backgroundColor: '#E0AE3C', borderWidth: 1, borderColor: '#2A333B' },
  overlaySkeleton: { color: '#E0AE3C', fontSize: 78, lineHeight: 79, textAlign: 'center', textShadowColor: 'rgba(0,0,0,.8)', textShadowRadius: 4 },
  overlayCaption: { position: 'absolute', top: 14, left: 14, backgroundColor: 'rgba(8,12,16,.86)', paddingHorizontal: 10, paddingVertical: 7, borderRadius: 8 },
  overlayCaptionText: { color: '#E0AE3C', fontSize: 10, fontWeight: '900', letterSpacing: .8 },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 15 },
  legendDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#E0AE3C' },
  legendText: { color: '#A2AFB9', fontSize: 11, fontWeight: '700', flex: 1 },
  legendFrame: { color: '#4FC7A2', fontSize: 11, fontWeight: '900' },
  overlayRow: { backgroundColor: '#181F26', borderWidth: 1, borderColor: '#2A333B', borderRadius: 14, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  overlayTime: { color: '#7FA5FF', fontSize: 11, fontWeight: '900', width: 72 },
  overlayLabel: { color: '#E8EDF2', fontSize: 13, fontWeight: '700', flex: 1 },
  frameControl: { minHeight: 58, backgroundColor: '#181F26', borderWidth: 1, borderColor: '#2A333B', borderRadius: 15, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  frameButton: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#1B2740', alignItems: 'center', justifyContent: 'center' },
  frameButtonText: { color: '#7FA5FF', fontSize: 28, lineHeight: 30, fontWeight: '700' },
  frameCenter: { alignItems: 'center', flex: 1 },
  frameTitle: { color: '#E8EDF2', fontSize: 13, fontWeight: '900', textAlign: 'center' },
  frameTime: { color: '#A2AFB9', fontSize: 11, marginTop: 3 },
  dataHeader: { backgroundColor: '#0A0F14', borderRadius: 18, padding: 18, flexDirection: 'row', alignItems: 'center', gap: 13, marginBottom: 15 },
  dataHeaderNumber: { color: '#E0AE3C', fontSize: 30, fontWeight: '900' },
  dataHeaderCopy: { color: '#E8EDF2', fontSize: 12, lineHeight: 18 },
  jointRow: { backgroundColor: '#181F26', borderBottomWidth: 1, borderBottomColor: '#222A31', padding: 13, flexDirection: 'row', alignItems: 'center', gap: 11 },
  jointIndex: { width: 24, color: '#7FA5FF', fontSize: 11, fontWeight: '900' },
  jointLabel: { color: '#E8EDF2', fontSize: 13, fontWeight: '800' },
  jointCoords: { color: '#A2AFB9', fontSize: 11, marginTop: 4, fontVariant: ['tabular-nums'] },
  jointVisibility: { color: '#4FC7A2', fontSize: 12, fontWeight: '900' },
  uploadActions: { flexDirection: 'row', gap: 9 },
  primaryDisabled: { opacity: .45 },
  capture: { flex: 1, padding: 22, paddingBottom: 36 },
  cameraFrame: { flex: 1, minHeight: 430, borderRadius: 22, overflow: 'hidden', backgroundColor: '#0A0F14' },
  camera: { flex: 1 },
  cameraPermission: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 15, padding: 24 },
  cameraPermissionText: { color: '#E8EDF2', fontSize: 14 },
  cameraGuide: { position: 'absolute', top: 18, left: 18, right: 18, alignItems: 'center' },
  cameraGuideText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800', backgroundColor: 'rgba(8,12,16,.82)', borderRadius: 99, paddingHorizontal: 12, paddingVertical: 8 },
  captureHint: { color: '#A2AFB9', fontSize: 12, textAlign: 'center', marginTop: 16 },
  recordButton: { height: 56, borderRadius: 16, backgroundColor: '#E4573E', marginTop: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
  recording: { backgroundColor: '#0A0F14' },
  recordButtonDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#181F26' },
  recordButtonText: { color: '#FFFFFF', fontWeight: '900', fontSize: 15 },
  recordNote: { backgroundColor: '#12291F', borderRadius: 16, padding: 16, marginTop: 18 },
  recordNoteTitle: { fontSize: 13, fontWeight: '900', color: '#4FC7A2' },
  recordNoteCopy: { fontSize: 12, lineHeight: 18, color: '#4FC7A2', marginTop: 6 },
  passportScore: { backgroundColor: '#0A0F14', borderRadius: 18, padding: 18, flexDirection: 'row', gap: 14, alignItems: 'center', marginBottom: 20 },
  passportScoreNumber: { fontSize: 28, fontWeight: '900', color: '#E0AE3C' },
  passportScoreTotal: { fontSize: 14, color: '#7FA5FF' },
  passportScoreTitle: { fontSize: 14, fontWeight: '800', color: '#FFFFFF' },
  passportScoreCopy: { fontSize: 12, lineHeight: 17, color: '#A2AFB9', marginTop: 4 },
  recordGroup: { marginBottom: 20 },
  recordGroupTitle: { fontSize: 12, fontWeight: '900', letterSpacing: .5, color: '#A2AFB9', marginBottom: 8 },
  recordItem: { padding: 14, backgroundColor: '#181F26', borderBottomWidth: 1, borderBottomColor: '#222A31', flexDirection: 'row', alignItems: 'center', gap: 10 },
  recordCheck: { height: 18, width: 18, borderRadius: 9, backgroundColor: '#12291F', color: '#4FC7A2', fontSize: 12, fontWeight: '900', textAlign: 'center' },
  recordItemText: { flex: 1, color: '#E8EDF2', fontSize: 13, fontWeight: '600' },
  recordArrow: { color: '#8B99A3', fontSize: 18 },
  passportWarning: { backgroundColor: '#2A2314', borderRadius: 16, padding: 16, marginTop: 3 },
  passportWarningTitle: { color: '#E0AE3C', fontSize: 13, fontWeight: '900' },
  passportWarningCopy: { color: '#E0AE3C', fontSize: 12, lineHeight: 18, marginTop: 5 },
  sourceResult: { backgroundColor: '#2A2314', borderRadius: 18, padding: 16, marginTop: 16 },
  sourceResultLabel: { fontSize: 11, fontWeight: '900', letterSpacing: .8, color: '#E0AE3C' },
  sourceResultTitle: { fontSize: 16, fontWeight: '900', color: '#A2AFB9', marginTop: 6 },
  sourceResultCopy: { fontSize: 12, lineHeight: 18, color: '#E0AE3C', marginVertical: 6 },
});
