/**
 * FormationStage3D.web.tsx 가 없을 때(네이티브 iOS/Android) 쓰는 대체 화면.
 * three.js 는 expo-gl 없이 네이티브에서 못 돌아가고, 이 기능은 웹 전용으로만 들여왔다.
 */
import { Text, View, type ViewStyle } from 'react-native';
import type { FormationDancer } from '../lib/formation';

export default function FormationStage3D({ style }: { dancers: FormationDancer[]; style?: ViewStyle }) {
  return (
    <View style={[style, { alignItems: 'center', justifyContent: 'center' }]}>
      <Text style={{ color: '#A2AFB9', fontSize: 12, textAlign: 'center', paddingHorizontal: 16 }}>
        3D 보기는 웹 브라우저에서만 지원돼요. 여기서는 아래 2D 무대를 사용해주세요.
      </Text>
    </View>
  );
}
