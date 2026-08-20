/**
 * 대형(formation) 구성 — 팀원 프로젝트의 lib/formation/{types,formationUtils}.ts 를 그대로
 * 옮긴 것. 팀원 쪽도 Supabase에 저장하지 않는 순수 클라이언트 상태였다(새로고침하면
 * 사라짐) — 그래서 이 포팅도 서버 작업이 필요 없다. 3D(react-three-fiber) 뷰는 대형
 * 편집의 본질(각 댄서의 바닥 x/z 좌표)과 무관한 장식이라 옮기지 않고, 실제 편집 표면이던
 * 2D 무대만 RN View + PanResponder 로 그대로 옮긴다.
 */

export interface FormationDancer {
  id: string;
  label: string;
  x: number;
  z: number;
}

export interface Formation {
  dancers: FormationDancer[];
}

export interface FormationSection {
  id: string;
  name: string;
  startSec: number;
  endSec: number;
  formation: Formation;
}

let idCounter = 0;
function nextDancerId(): string {
  idCounter += 1;
  return `d${idCounter}`;
}

/** rows x cols 그리드로 정확히 배치한다. count 가 rows*cols 보다 적으면 마지막 행만 모자란 채로 채워진다. */
export function makeGridFormation(rows: number, cols: number, count: number, rowSpacing = 1.4, colSpacing = 1.4): Formation {
  const dancers: FormationDancer[] = [];
  const total = Math.min(count, rows * cols);
  const rowWidth = (cols - 1) * colSpacing;
  const colDepth = (rows - 1) * rowSpacing;
  for (let i = 0; i < total; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    dancers.push({ id: nextDancerId(), label: String(i + 1), x: c * colSpacing - rowWidth / 2, z: r * rowSpacing - colDepth / 2 });
  }
  return { dancers };
}

export function makeEmptyDancer(index: number): FormationDancer {
  return { id: nextDancerId(), label: String(index + 1), x: 0, z: 0 };
}

export function makeDancerAt(index: number, x: number, z: number): FormationDancer {
  return { id: nextDancerId(), label: String(index + 1), x, z };
}

/** step<=0 이면 스냅 없이 소수점 첫째 자리로만 반올림한다. */
export function snapTo(value: number, step: number): number {
  if (step <= 0) return Math.round(value * 10) / 10;
  return Math.round(value / step) * step;
}
