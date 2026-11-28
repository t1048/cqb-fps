import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

interface NvgUniforms {
  uNvg: { value: number };
  uNvgGain: { value: number };
  uNvgBloom: { value: number };
  uNvgFlare: { value: number };
  uNvgGlarePos: { value: THREE.Vector2 };
  uNvgAspect: { value: number };
  uNvgTime: { value: number };
}

/**
 * ワールド描画のポストプロセス: GTAO（接地・隅の陰影）→ 周辺減光＋トーンマップ/色空間変換。
 * 一人称装備は別シーンで後から重ねるため、ここには含めない。
 */
export class PostFX {
  private readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;
  private readonly gtao: GTAOPass;
  private readonly outputPass: OutputPass;
  private aoEnabled = true;
  private readonly nvgUniforms: NvgUniforms;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ) {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    const pr = renderer.getPixelRatio();
    const effW = Math.max(1, Math.floor(w * pr));
    const effH = Math.max(1, Math.floor(h * pr));
    // 1x1 仮ターゲットで生成後、setPixelRatio -> setSize をパス追加後に1回だけ呼んで無駄な再確保を防ぐ
    const rt = new THREE.WebGLRenderTarget(1, 1, {
      samples: renderer.capabilities.isWebGL2 ? 4 : 0,
      type: THREE.HalfFloatType,
    });
    this.composer = new EffectComposer(renderer, rt);
    // フルスクリーン矩形を描く ping-pong 側ターゲットでは 4x MSAA blit を無効化する
    this.composer.renderTarget2.samples = 0;

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.gtao = new GTAOPass(scene, camera, effW, effH);
    this.gtao.output = GTAOPass.OUTPUT.Default;
    this.gtao.blendIntensity = 0.85;
    this.gtao.updateGtaoMaterial({
      radius: 0.45,
      distanceExponent: 1.4,
      thickness: 1.2,
      scale: 1.0,
      samples: 8,
      distanceFallOff: 1,
      screenSpaceRadius: false,
    });
    this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 3, samples: 8 });
    this.composer.addPass(this.gtao);

    this.outputPass = new OutputPass();
    this.outputPass.needsSwap = false;
    // 独立したフルスクリーン HalfFloat パスを増やさず、トーンマップ前の線形空間で周辺減光を合成する
    // 暗視装置（白色蛍光のオートゲート増幅管）: トーンマップ前の線形空間で輝度を増幅し、粒状ノイズと光源周囲の局所ハローを足す
    const u = this.outputPass.material.uniforms;
    u.uNvg = { value: 0 };
    u.uNvgGain = { value: 14 };
    u.uNvgBloom = { value: 0 };
    u.uNvgFlare = { value: 0 };
    u.uNvgGlarePos = { value: new THREE.Vector2(0.5, 0.5) };
    u.uNvgAspect = { value: w / h };
    u.uNvgTime = { value: 0 };
    this.nvgUniforms = u as unknown as NvgUniforms;
    this.outputPass.material.fragmentShader = this.outputPass.material.fragmentShader
      .replace(
        'varying vec2 vUv;',
        /* glsl */ `varying vec2 vUv;
		uniform float uNvg;
		uniform float uNvgGain;
		uniform float uNvgBloom;
		uniform float uNvgFlare;
		uniform vec2 uNvgGlarePos;
		uniform float uNvgAspect;
		uniform float uNvgTime;
		float nvgHash( vec2 p ) { return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ); }`,
      )
      .replace(
        'gl_FragColor = texture2D( tDiffuse, vUv );',
        /* glsl */ `gl_FragColor = texture2D( tDiffuse, vUv );
			vec2 vigD = vUv - 0.5;
			gl_FragColor.rgb *= 1.0 - 0.28 * smoothstep( 0.18, 0.62, dot( vigD, vigD ) * 1.6 );
			if ( uNvg > 0.0 ) {
				float lum = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
				// 増幅: 暗部ほど強く持ち上げ、明部はオートゲート管の飽和で頭打ち
				float amp = lum * uNvgGain;
				amp = amp / ( 1.0 + amp * 0.9 );
				float grain = nvgHash( floor( vUv * vec2( 960.0, 540.0 ) ) + fract( uNvgTime * 37.0 ) * 91.7 ) - 0.5;
				amp += grain * ( 0.035 + 0.055 / ( 1.0 + amp * 6.0 ) );
				amp += 0.012;
				// 正面から照らされたときの局所ハロー（光源 UV の周囲だけ強く光るフォトニックバリア）
				if ( uNvgBloom > 0.001 ) {
					vec2 gd = ( vUv - uNvgGlarePos ) * vec2( uNvgAspect, 1.0 );
					float dist = length( gd );
					float core = exp( -dist * dist * 110.0 ) * 1.45;
					float halo = exp( -dist * 7.5 ) * 0.42;
					float veil = exp( -dist * 2.2 ) * 0.08;
					amp += ( core + halo + veil ) * clamp( uNvgBloom, 0.0, 1.0 );
				}
				// オートゲート追従までの一瞬だけの控えめな露出跳ね上がり（全画面を真っ白にしない）
				amp += clamp( uNvgFlare, 0.0, 1.0 ) * 0.22;
				// 高輝度のソフトロールオフ
				amp = amp / ( 1.0 + max( amp - 0.85, 0.0 ) * 0.45 );
				vec3 phosphor = vec3( 0.80, 0.90, 1.0 ) * max( amp, 0.0 );
				gl_FragColor.rgb = mix( gl_FragColor.rgb, phosphor, uNvg );
			}`,
      );
    this.composer.addPass(this.outputPass);

    // _width/_height を論理サイズに揃えた上で pixelRatio を反映し、実ピクセル解像度で1回だけ確保する
    (this.composer as unknown as { _width: number; _height: number })._width = w;
    (this.composer as unknown as { _height: number })._height = h;
    this.composer.setPixelRatio(pr);
  }

  /** 共有レンダラ利用時に新しいシーン・カメラへ差し替える。 */
  rebind(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    this.renderPass.scene = scene;
    this.renderPass.camera = camera;
    this.gtao.scene = scene;
    this.gtao.camera = camera;
    const gtaoInternal = this.gtao as unknown as { _visibilityCache?: unknown[] };
    if (gtaoInternal._visibilityCache) gtaoInternal._visibilityCache.length = 0;
    const gtaoUniforms = this.gtao.gtaoMaterial.uniforms;
    if (gtaoUniforms.cameraNear) gtaoUniforms.cameraNear.value = camera.near;
    if (gtaoUniforms.cameraFar) gtaoUniforms.cameraFar.value = camera.far;
    if (gtaoUniforms.cameraProjectionMatrix) gtaoUniforms.cameraProjectionMatrix.value.copy(camera.projectionMatrix);
    if (gtaoUniforms.cameraProjectionMatrixInverse) gtaoUniforms.cameraProjectionMatrixInverse.value.copy(camera.projectionMatrixInverse);
    const pdUniforms = this.gtao.pdMaterial.uniforms;
    if (pdUniforms.cameraProjectionMatrixInverse) pdUniforms.cameraProjectionMatrixInverse.value.copy(camera.projectionMatrixInverse);
    const depthUniforms = this.gtao.depthRenderMaterial.uniforms;
    if (depthUniforms.cameraNear) depthUniforms.cameraNear.value = camera.near;
    if (depthUniforms.cameraFar) depthUniforms.cameraFar.value = camera.far;
  }

  /**
   * 暗視装置の画面効果。amount 0..1（装着の切り替えで補間）、gain は増幅率（暗いほど大きく、オートゲートで低下）、
   * bloom 0..1 は光源周囲の局所ハロー強度、flare 0..1 は急照射直後の一瞬の露出跳ね上がり。
   */
  setNightVision(
    amount: number,
    gain: number,
    bloom: number,
    time: number,
    flare = 0,
    glareUvX = 0.5,
    glareUvY = 0.5,
  ): void {
    const u = this.nvgUniforms;
    u.uNvg.value = amount;
    u.uNvgGain.value = gain;
    u.uNvgBloom.value = bloom;
    u.uNvgFlare.value = flare;
    u.uNvgGlarePos.value.set(glareUvX, glareUvY);
    u.uNvgTime.value = time;
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
    this.nvgUniforms.uNvgAspect.value = w / Math.max(1, h);
    this.composer.setSize(w, h);
  }

  render(dt?: number): void {
    // RenderPass は readBuffer に 3D シーンを描画するため、毎フレーム MSAA 側 (renderTarget1) に固定する
    this.composer.readBuffer = this.composer.renderTarget1;
    this.composer.writeBuffer = this.composer.renderTarget2;
    this.composer.render(dt);
  }

  dispose(): void {
    const normalRt = (this.gtao as unknown as { normalRenderTarget?: THREE.WebGLRenderTarget }).normalRenderTarget;
    normalRt?.depthTexture?.dispose();
    this.gtao.depthTexture?.dispose();
    this.gtao.gtaoMaterial.dispose();
    this.gtao.blendMaterial.dispose();
    this.gtao.dispose();
    this.outputPass.dispose();
    this.composer.dispose();
  }
}
