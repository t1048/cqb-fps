import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/** 周辺減光 + ごく弱い色収差風のコントラスト（線形空間で適用。トーンマップ前）。 */
const VignetteShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    strength: { value: 0.28 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float strength;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5;
      float v = 1.0 - strength * smoothstep(0.18, 0.62, dot(d, d) * 1.6);
      gl_FragColor = vec4(c.rgb * v, c.a);
    }`,
};

/**
 * ワールド描画のポストプロセス: GTAO（接地・隅の陰影）→ 周辺減光 → トーンマップ/色空間変換。
 * 一人称装備は別シーンで後から重ねるため、ここには含めない。
 */
export class PostFX {
  private readonly composer: EffectComposer;
  private readonly gtao: GTAOPass;
  private readonly vignette: ShaderPass;
  private aoEnabled = true;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pr = renderer.getPixelRatio();
    const rt = new THREE.WebGLRenderTarget(w * pr, h * pr, {
      samples: renderer.capabilities.isWebGL2 ? 4 : 0,
      type: THREE.HalfFloatType,
    });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.composer.addPass(new RenderPass(scene, camera));
    this.gtao = new GTAOPass(scene, camera, w, h);
    this.gtao.output = GTAOPass.OUTPUT.Default;
    this.gtao.blendIntensity = 0.85;
    this.gtao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: 8, distanceFallOff: 1, screenSpaceRadius: false });
    this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 3, samples: 8 });
    this.composer.addPass(this.gtao);
    this.vignette = new ShaderPass(VignetteShader);
    this.composer.addPass(this.vignette);
    this.composer.addPass(new OutputPass());
  }

  /** 低解像度まで落ちた環境では AO を切って負荷を下げる。 */
  setAO(on: boolean): void {
    if (on === this.aoEnabled) return;
    this.aoEnabled = on;
    this.gtao.enabled = on;
  }

  setPixelRatio(r: number): void {
    this.composer.setPixelRatio(r);
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
  }

  render(dt?: number): void {
    this.composer.render(dt);
  }

  dispose(): void {
    this.gtao.dispose();
    this.vignette.dispose();
    this.composer.dispose();
  }
}
