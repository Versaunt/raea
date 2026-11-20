// @remotion/three's video textures: not used by the lab's ads; named so an import resolves, and say so when called.
export function useVideoTexture(): never {
  throw new Error("useVideoTexture: raea's R3F reader doesn't take a video texture from @remotion/three yet");
}
export const useOffthreadVideoTexture = useVideoTexture;
