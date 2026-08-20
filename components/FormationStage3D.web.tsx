/**
 * 대형 3D 무대 — 팀원의 StageView.tsx + DancerFigure.tsx 를 그대로 이식(캡슐+구체 몸통,
 * 링 모양 바닥 표시, OrbitControls 자유 회전). 색만 이 앱의 팔레트(#7FA5FF)로 바꿨다.
 *
 * .web.tsx 로 분리한 이유: three.js/@react-three/fiber 는 웹(react-dom, HTMLCanvasElement)
 * 전용으로 쓴다 — 네이티브에서 쓰려면 expo-gl 이 필요한데 설치하지 않았다. 파일 확장자
 * 분리(.web.tsx vs 기본 .tsx)를 쓰면 Metro가 플랫폼별로 완전히 다른 파일을 골라 네이티브
 * 빌드에는 이 파일 자체가 아예 포함되지 않는다 — mediapipe/tasks-vision 때 겪은 것처럼
 * Metro가 라이브러리 내부 코드를 정적 분석하다 깨지는 위험을 원천적으로 피한다.
 */
import { useState } from 'react';
import { View, type ViewStyle } from 'react-native';
import { Canvas, type ThreeEvent } from '@react-three/fiber';
import { Grid, OrbitControls, Text } from '@react-three/drei';
import type { FormationDancer } from '../lib/formation';

function DancerFigure({ dancer, highlight, onSelect }: { dancer: FormationDancer; highlight: boolean; onSelect: () => void }) {
  const color = highlight ? '#9DB8F5' : '#7FA5FF';
  return (
    <group position={[dancer.x, 0, dancer.z]} onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onSelect(); }}>
      <mesh position={[0, 0.62, 0]} castShadow>
        <capsuleGeometry args={[0.18, 0.55, 4, 8]} />
        <meshStandardMaterial color={color} roughness={0.5} metalness={0.1} />
      </mesh>
      <mesh position={[0, 1.15, 0]} castShadow>
        <sphereGeometry args={[0.16, 16, 16]} />
        <meshStandardMaterial color={color} roughness={0.5} metalness={0.1} />
      </mesh>
      <mesh position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.2, 0.26, 24]} />
        <meshBasicMaterial color="#7FA5FF" transparent opacity={0.6} />
      </mesh>
      <Text position={[0, 1.55, 0]} fontSize={0.22} color="#E8EDF2" anchorX="center" anchorY="bottom">
        {dancer.label}
      </Text>
    </group>
  );
}

export default function FormationStage3D({ dancers, style }: { dancers: FormationDancer[]; style?: ViewStyle }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <View style={style}>
      <Canvas
        shadows
        camera={{ position: [0, 4.5, 7], fov: 45 }}
        style={{ width: '100%', height: '100%' }}
        onPointerMissed={() => setSelectedId(null)}
      >
        <ambientLight intensity={0.6} />
        <directionalLight position={[3, 6, 4]} intensity={1.1} castShadow shadow-mapSize={[1024, 1024]} />
        <Grid
          args={[20, 20]}
          cellSize={0.5}
          cellThickness={0.5}
          cellColor="#2A333B"
          sectionSize={2.5}
          sectionThickness={1}
          sectionColor="#3A4B6B"
          fadeDistance={18}
          fadeStrength={1.5}
          infiniteGrid
        />
        {dancers.map(d => <DancerFigure key={d.id} dancer={d} highlight={d.id === selectedId} onSelect={() => setSelectedId(d.id)} />)}
        <OrbitControls enablePan={false} minDistance={2.5} maxDistance={16} maxPolarAngle={Math.PI / 2.1} />
      </Canvas>
    </View>
  );
}
