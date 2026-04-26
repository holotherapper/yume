import * as THREE from 'three';
import type { SceneData, SceneBuilding, ScenePath, SceneActor, SceneRelationship } from '../types';

const DIST_TARGET: Record<string, number> = { adjacent: 56, near: 110, far: 200 };

function hashId(s: unknown): number {
  if (s == null) return 0;
  const str = String(s);
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function computeLayout(buildings: SceneBuilding[], paths: ScenePath[]) {
  const N = buildings.length;
  const pos: Record<string, { x: number; z: number }> = {};
  buildings.forEach((b, i) => {
    const a = (i / N) * Math.PI * 2;
    const r = 90 + (hashId(b.id) % 30);
    pos[b.id] = { x: Math.cos(a) * r, z: Math.sin(a) * r };
  });
  const station = buildings.find(b => b.id === 'station') || buildings.find(b => b.kind === 'district');
  if (station) pos[station.id] = { x: 0, z: 0 };
  const edges = paths.map(p => ({ a: p[0], b: p[1], target: DIST_TARGET[p[2]] ?? 110 }));
  for (let iter = 0; iter < 600; iter++) {
    const cool = 1 - iter / 600;
    const force: Record<string, { x: number; z: number }> = {};
    buildings.forEach(b => { force[b.id] = { x: 0, z: 0 }; });
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const A = buildings[i].id, B = buildings[j].id;
        const dx = pos[A].x - pos[B].x, dz = pos[A].z - pos[B].z;
        let d2 = dx * dx + dz * dz; if (d2 < 1) d2 = 1;
        const f = 4200 / d2;
        const d = Math.sqrt(d2);
        force[A].x += (dx / d) * f; force[A].z += (dz / d) * f;
        force[B].x -= (dx / d) * f; force[B].z -= (dz / d) * f;
      }
    }
    edges.forEach(e => {
      const A = pos[e.a], B = pos[e.b]; if (!A || !B) return;
      const dx = B.x - A.x, dz = B.z - A.z;
      const d = Math.sqrt(dx * dx + dz * dz) || 1;
      const k = 0.06 * (d - e.target);
      force[e.a].x += (dx / d) * k; force[e.a].z += (dz / d) * k;
      force[e.b].x -= (dx / d) * k; force[e.b].z -= (dz / d) * k;
    });
    buildings.forEach(b => {
      force[b.id].x -= pos[b.id].x * 0.002;
      force[b.id].z -= pos[b.id].z * 0.002;
    });
    buildings.forEach(b => {
      if (station && b.id === station.id) return;
      const f = force[b.id];
      const step = Math.min(8, Math.sqrt(f.x * f.x + f.z * f.z));
      const mag = Math.sqrt(f.x * f.x + f.z * f.z) || 1;
      pos[b.id].x += (f.x / mag) * step * cool;
      pos[b.id].z += (f.z / mag) * step * cool;
    });
  }
  return pos;
}

const KIND_SPEC: Record<string, { wMin: number; wMax: number; dMin: number; dMax: number; hMin: number; hMax: number }> = {
  tall:  { wMin: 22, wMax: 32, dMin: 22, dMax: 30, hMin: 70,  hMax: 130 },
  block: { wMin: 28, wMax: 46, dMin: 24, dMax: 38, hMin: 16,  hMax: 32  },
  flat:  { wMin: 44, wMax: 70, dMin: 38, dMax: 60, hMin: 1.5, hMax: 3   },
};

function specForBuilding(b: SceneBuilding) {
  const k = KIND_SPEC[b.kind] || KIND_SPEC.block;
  const seed = hashId(b.id);
  const lerp = (a: number, c: number, t: number) => a + (c - a) * t;
  const r = (n: number, mod: number) => ((seed >> (n * 3)) % mod) / mod;
  return { kind: b.kind || 'block', w: lerp(k.wMin, k.wMax, r(0, 100)), d: lerp(k.dMin, k.dMax, r(1, 100)), h: lerp(k.hMin, k.hMax, r(2, 100)) };
}

type ModeConfig = {
  bg: number; ground: number; grid: number; fog: [number, number];
  light: { hemi: [number, number, number]; dir: [number, number] };
  actor: number; accent: number;
  labelText?: number; labelBg?: number;
  pathColor?: number; relColor?: number;
  roleColor?: Record<string, number>;
  palette?: number[];
  kindColor: Record<string, number>;
  contourPalette?: number[];
  addEdges?: boolean; edgeColor?: number; edgeOpacity?: number; edgeOnly?: boolean;
  translucent?: boolean; opacity?: number;
  windows?: boolean; windowColor?: number; windowOpacity?: number; windowPalette?: number[];
  contour?: boolean; contourColor?: number; contourOpacity?: number; contourEvery?: number;
  ringColor?: number; glowActor?: boolean; gridStrong?: boolean;
};

type ViewFrame = {
  center: THREE.Vector3;
  radius: number;
  distance: number;
  minDistance: number;
  maxDistance: number;
  groundSize: number;
};

const MODES: Record<string, ModeConfig> = {
  research: {
    bg: 0xeceef1, ground: 0xdee1e6, grid: 0xb8bdc4, fog: [700, 1500],
    light: { hemi: [0xffffff, 0xc8cdd4, 0.95], dir: [0xffffff, 0.85] },
    actor: 0x8a939e, accent: 0x3a4048,
    labelText: 0x111827, labelBg: 0xffffff,
    roleColor: { transit: 0x4a7fd6, residential: 0xe89a7a, civic: 0xe6b85a, commercial: 0x8fb86a, workplace: 0x8a78d9, health: 0x4fb8aa, park: 0x6fa860, construction: 0xd97a4a },
    kindColor: { tall: 0x8a78d9, block: 0xa8adb4, flat: 0x6fa860 },
    addEdges: true, edgeColor: 0x1a1d22, edgeOpacity: 0.55,
    translucent: true, opacity: 0.55, ringColor: 0x3a4048,
    pathColor: 0x2a3040, relColor: 0x4a5060,
  },
  clay: {
    bg: 0xeae6df, ground: 0xd9d4cb, grid: 0xbfb8ac, fog: [600, 1400],
    light: { hemi: [0xffffff, 0xc8bfb0, 0.85], dir: [0xffffff, 0.9] },
    actor: 0x2a2826, accent: 0x5a544a, pathColor: 0xa39c8e, relColor: 0x8a8378,
    palette: [0xc7b9a0, 0xd6c8b0, 0xa8b8a3, 0xc7a89a, 0xb8b8b8, 0x9eb0b8, 0xd9c890],
    kindColor: { tall: 0xcfc4b0, block: 0xe5dccb, flat: 0x9aa897 },
    addEdges: true, edgeColor: 0x5a544a, edgeOpacity: 0.55, ringColor: 0x2a2826,
  },
  night: {
    bg: 0x06080d, ground: 0x0c0f15, grid: 0x1a1f28, fog: [500, 1300],
    light: { hemi: [0x9ab8ff, 0x06080d, 0.25], dir: [0xeae6ff, 0.35] },
    actor: 0xfff2c8, accent: 0xffd47a, pathColor: 0x2a3344, relColor: 0x3a4458,
    palette: [0x10131a, 0x121620, 0x141821, 0x1a1d22, 0x161a1f, 0x181d28],
    kindColor: { tall: 0x10131a, block: 0x141821, flat: 0x0e1118 },
    windows: true, windowColor: 0xffd98a, windowOpacity: 0.9,
    windowPalette: [0xffd07a, 0xfff0c8, 0xa9d6ff, 0xc8e6ff, 0xffe4a8],
    ringColor: 0xffd47a, glowActor: true,
  },
  topo: {
    bg: 0x0d1014, ground: 0x141820, grid: 0x202632, fog: [600, 1400],
    light: { hemi: [0xffffff, 0x101218, 0.4], dir: [0xffffff, 0.4] },
    actor: 0xe6ecf2, accent: 0x9aa6b4, pathColor: 0x2a3140, relColor: 0x4a5466,
    palette: [0x1a1f28, 0x18222a, 0x1c1d28, 0x1d2127, 0x1a1d20],
    contourPalette: [0x6cd4c2, 0x8ca8ff, 0xffb86b, 0xc78bff, 0xf9c468, 0x6ce0a3],
    kindColor: { tall: 0x1a1f28, block: 0x1a1f28, flat: 0x161a22 },
    contour: true, contourColor: 0x6c7686, contourOpacity: 0.95, contourEvery: 8, ringColor: 0xe6ecf2,
  },
  blueprint: {
    bg: 0x0a3a78, ground: 0x0d4690, grid: 0x4f8fd8, fog: [600, 1500],
    light: { hemi: [0xffffff, 0x0a3a78, 0.6], dir: [0xffffff, 0.0] },
    actor: 0xeaf3ff, accent: 0xb8d3ff, pathColor: 0x9ec3f5, relColor: 0xb8d3ff,
    palette: [0xeaf3ff, 0xeaf3ff, 0xeaf3ff, 0xeaf3ff, 0xfff0a8, 0xff9e9e, 0xa8ffd2],
    kindColor: { tall: 0x0a3a78, block: 0x0a3a78, flat: 0x0a3a78 },
    addEdges: true, edgeColor: 0xeaf3ff, edgeOpacity: 1.0, edgeOnly: true,
    gridStrong: true, ringColor: 0xeaf3ff,
  },
};

function makeLabel(text: string, bg: number, ink: number, size = 14, marker?: number): THREE.Sprite {
  const c = document.createElement('canvas');
  const pad = 6;
  const markerW = marker != null ? 12 : 0;
  const g = c.getContext('2d')!;
  g.font = `500 ${size * 2}px ui-sans-serif, system-ui, sans-serif`;
  const w = g.measureText(text).width + pad * 2 + markerW;
  c.width = Math.ceil(w); c.height = Math.ceil(size * 2 + pad * 2);
  const g2 = c.getContext('2d')!;
  const r = (bg >> 16) & 0xff, gr = (bg >> 8) & 0xff, bl = bg & 0xff;
  g2.fillStyle = `rgba(${r},${gr},${bl},0.85)`;
  g2.fillRect(0, 0, c.width, c.height);
  if (marker != null) {
    const mr = (marker >> 16) & 0xff, mg = (marker >> 8) & 0xff, mb = marker & 0xff;
    g2.fillStyle = `rgb(${mr},${mg},${mb})`;
    g2.beginPath();
    g2.arc(pad + 4, c.height / 2, 4, 0, Math.PI * 2);
    g2.fill();
  }
  g2.font = `500 ${size * 2}px ui-sans-serif, system-ui, sans-serif`;
  const ir = (ink >> 16) & 0xff, ig = (ink >> 8) & 0xff, ib = ink & 0xff;
  g2.fillStyle = `rgba(${ir},${ig},${ib},0.95)`;
  g2.textBaseline = 'middle';
  g2.fillText(text, pad + markerW, c.height / 2 + 1);
  const tex = new THREE.CanvasTexture(c); tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const sp = new THREE.Sprite(mat);
  const ratio = c.width / c.height;
  sp.scale.set(24 * ratio / 3, 24 / 3, 1);
  sp.renderOrder = marker != null ? 12 : 10;
  return sp;
}

function makeBuildingMesh(b: SceneBuilding, mode: ModeConfig, spec: any): THREE.Group {
  const group = new THREE.Group();
  const { w, d, h, kind } = spec;
  const seed = hashId(b.id);
  const pickIdx = (arr: number[]) => arr[seed % arr.length];
  const roleC = mode.roleColor && b.role ? mode.roleColor[b.role] : null;
  const color = roleC ?? (mode.palette ? pickIdx(mode.palette) : (mode.kindColor[kind] ?? mode.kindColor.block));
  const edgeColor = mode.edgeOnly && mode.palette ? pickIdx(mode.palette) : mode.edgeColor;

  if (mode.edgeOnly) {
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d));
    const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: mode.edgeOpacity ?? 1 }));
    line.position.y = h / 2;
    group.add(line);
  } else if (mode.contour) {
    const cColor = mode.contourPalette ? pickIdx(mode.contourPalette) : (mode.contourColor ?? 0x6c7686);
    const layers = Math.max(2, Math.round(h / (mode.contourEvery ?? 8)));
    for (let i = 0; i <= layers; i++) {
      const y = (i / layers) * h;
      const rect = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-w / 2, y, -d / 2), new THREE.Vector3(w / 2, y, -d / 2),
        new THREE.Vector3(w / 2, y, d / 2), new THREE.Vector3(-w / 2, y, d / 2),
        new THREE.Vector3(-w / 2, y, -d / 2),
      ]);
      const op = (mode.contourOpacity ?? 0.95) * (0.45 + 0.55 * (1 - i / layers));
      group.add(new THREE.Line(rect, new THREE.LineBasicMaterial({ color: cColor, transparent: true, opacity: op })));
    }
  } else {
    const mat = new THREE.MeshStandardMaterial({
      color, roughness: 0.92, metalness: 0.0, flatShading: true,
      transparent: !!mode.translucent, opacity: mode.translucent ? (mode.opacity ?? 0.55) : 1.0,
    });
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.y = h / 2; m.castShadow = true; m.receiveShadow = true;
    group.add(m);
    if (mode.addEdges) {
      const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d));
      group.add(new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: mode.edgeColor, transparent: true, opacity: mode.edgeOpacity })));
      group.children[group.children.length - 1].position.y = h / 2;
    }
  }
  group.position.set(spec.x, 0, spec.z);
  group.userData = { kind: 'building', id: b.id };
  return group;
}

export type SceneOptions = {
  mode?: string;
  camera?: string;
  actorStyle?: string;
  onActorClick?: (id: string) => void;
};

export class YumeScene {
  private _data!: SceneData;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private mount!: HTMLElement;
  private mode!: ModeConfig;
  private bspecs: Record<string, any> = {};
  private buildings: Record<string, THREE.Group> = {};
  private actors: Record<string, THREE.Group> = {};
  private actorGroup!: THREE.Group;
  private relGroup!: THREE.Group;
  private focusRings: THREE.Group | null = null;
  private focusActorId: string | null = null;
  private orbit = { yaw: Math.PI / 6, pitch: Math.PI / 3.3, distance: 520, target: new THREE.Vector3(0, 0, 0) };
  private viewFrame: ViewFrame = {
    center: new THREE.Vector3(0, 0, 0),
    radius: 320,
    distance: 620,
    minDistance: 160,
    maxDistance: 1400,
    groundSize: 1200,
  };
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2(-10, -10);
  private _raf = 0;
  private _t = 0;
  private _onResize: (() => void) | null = null;
  private opts: SceneOptions = {};

  init(mount: HTMLElement, data: SceneData, opts: SceneOptions = {}) {
    this._data = data;
    this.mount = mount;
    this.opts = opts;
    const mode = this.mode = MODES[opts.mode || 'research'] || MODES.research;

    const hasPositions = data.buildings.some(b => b.position);
    const layout = hasPositions ? null : computeLayout(data.buildings, data.paths);
    data.buildings.forEach(b => {
      const sp = specForBuilding(b);
      const x = b.position?.x ?? layout?.[b.id]?.x ?? 0;
      const z = b.position?.z ?? layout?.[b.id]?.z ?? 0;
      this.bspecs[b.id] = { ...sp, x, z };
    });
    this.viewFrame = this._computeViewFrame();
    this.orbit.target.copy(this.viewFrame.center);

    const scene = this.scene = new THREE.Scene();
    scene.background = new THREE.Color(mode.bg);
    scene.fog = new THREE.Fog(
      mode.bg,
      Math.max(mode.fog[0], this.viewFrame.distance * 2.0),
      Math.max(mode.fog[1], this.viewFrame.distance * 4.0),
    );

    const w = mount.clientWidth, h = mount.clientHeight;
    this.camera = new THREE.PerspectiveCamera(35, w / h, 1, Math.max(3000, this.viewFrame.maxDistance * 2.5));
    this.setCameraPreset(opts.camera || 'isometric');

    const renderer = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.setSize(w, h);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(mode.light.hemi[0], mode.light.hemi[1], mode.light.hemi[2]));
    const dir = new THREE.DirectionalLight(mode.light.dir[0], mode.light.dir[1]);
    dir.position.set(this.viewFrame.center.x + 240, 420 + this.viewFrame.radius * 0.16, this.viewFrame.center.z + 180); dir.castShadow = true;
    dir.target.position.copy(this.viewFrame.center);
    scene.add(dir.target);
    dir.shadow.mapSize.set(2048, 2048);
    const shadowRange = Math.max(400, this.viewFrame.radius * 1.25);
    dir.shadow.camera.left = -shadowRange; dir.shadow.camera.right = shadowRange;
    dir.shadow.camera.top = shadowRange; dir.shadow.camera.bottom = -shadowRange;
    dir.shadow.camera.near = 50; dir.shadow.camera.far = Math.max(900, this.viewFrame.radius * 3.0);
    scene.add(dir);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(this.viewFrame.groundSize, this.viewFrame.groundSize), new THREE.MeshStandardMaterial({ color: mode.ground, roughness: 0.95 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
    ground.position.set(this.viewFrame.center.x, 0, this.viewFrame.center.z);
    scene.add(ground);
    const grid = new THREE.GridHelper(this.viewFrame.groundSize, Math.max(48, Math.round(this.viewFrame.groundSize / 36)), mode.grid, mode.grid);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = mode.gridStrong ? 0.55 : 0.22;
    grid.position.set(this.viewFrame.center.x, 0.02, this.viewFrame.center.z);
    scene.add(grid);

    data.buildings.forEach(b => {
      const spec = this.bspecs[b.id];
      const m = makeBuildingMesh(b, mode, spec);
      scene.add(m);
      this.buildings[b.id] = m;
      const label = makeLabel(b.name, mode.labelBg ?? mode.bg, mode.labelText ?? mode.accent ?? mode.actor);
      label.position.set(spec.x, spec.h + 18, spec.z);
      scene.add(label);
    });

    const proxGroup = new THREE.Group();
    const ids = Object.keys(this.bspecs);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = this.bspecs[ids[i]], b = this.bspecs[ids[j]];
        const dist = Math.hypot(a.x - b.x, a.z - b.z);
        if (dist > 250) continue;
        const opacity = Math.max(0.2, 0.7 * (1 - dist / 250));
        const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a.x, 0.12, a.z), new THREE.Vector3(b.x, 0.12, b.z)]);
        const mat = new THREE.LineBasicMaterial({ color: mode.pathColor ?? 0x4a5060, transparent: true, opacity });
        proxGroup.add(new THREE.Line(geo, mat));
      }
    }
    scene.add(proxGroup);

    this.actorGroup = new THREE.Group();
    data.actors.forEach(a => {
      const node = this._makeActor(a, opts.actorStyle || 'pillar');
      this.actors[a.id] = node;
      this.actorGroup.add(node);
    });
    scene.add(this.actorGroup);

    this.relGroup = new THREE.Group();
    scene.add(this.relGroup);
    this._rebuildRels();

    this._onResize = () => {
      const w2 = mount.clientWidth, h2 = mount.clientHeight;
      renderer.setSize(w2, h2);
      this.camera.aspect = w2 / h2;
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', this._onResize);
    this._setupControls();

    renderer.domElement.addEventListener('mousemove', (e) => {
      const r = renderer.domElement.getBoundingClientRect();
      this.mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    });
    renderer.domElement.addEventListener('click', () => {
      const hit = this._pickActor();
      if (hit && this.opts.onActorClick) this.opts.onActorClick(hit);
    });

    const clock = new THREE.Clock();
    const tick = () => {
      this._raf = requestAnimationFrame(tick);
      this._animate(clock.getDelta());
      renderer.render(scene, this.camera);
    };
    tick();
  }

  private _computeViewFrame(): ViewFrame {
    const specs = Object.values(this.bspecs);
    if (!specs.length) {
      return {
        center: new THREE.Vector3(0, 0, 0),
        radius: 320,
        distance: 620,
        minDistance: 160,
        maxDistance: 1400,
        groundSize: 1200,
      };
    }

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const spec of specs) {
      minX = Math.min(minX, spec.x - spec.w / 2);
      maxX = Math.max(maxX, spec.x + spec.w / 2);
      minZ = Math.min(minZ, spec.z - spec.d / 2);
      maxZ = Math.max(maxZ, spec.z + spec.d / 2);
    }

    const center = new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    let radius = 0;
    for (const spec of specs) {
      const spread = Math.max(spec.w, spec.d, spec.h) * 0.5;
      radius = Math.max(radius, Math.hypot(spec.x - center.x, spec.z - center.z) + spread);
    }

    radius = Math.max(320, radius);
    return {
      center,
      radius,
      distance: Math.max(620, radius * 1.85),
      minDistance: Math.max(160, radius * 0.35),
      maxDistance: Math.max(1400, radius * 4.0),
      groundSize: Math.max(1200, radius * 2.8),
    };
  }

  private _setupControls() {
    const dom = this.renderer.domElement;
    let dragging = false, rightDragging = false, lx = 0, ly = 0;
    dom.addEventListener('mousedown', (e) => { if (e.button === 0) dragging = true; else rightDragging = true; lx = e.clientX; ly = e.clientY; });
    const up = () => { dragging = false; rightDragging = false; };
    const move = (e: MouseEvent) => {
      if (!dragging && !rightDragging) return;
      const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
      if (dragging) {
        this.orbit.yaw -= dx * 0.005;
        this.orbit.pitch -= dy * 0.005;
        this.orbit.pitch = Math.max(0.15, Math.min(Math.PI / 2 - 0.05, this.orbit.pitch));
      } else {
        const right = new THREE.Vector3(Math.cos(this.orbit.yaw), 0, -Math.sin(this.orbit.yaw));
        const fwd = new THREE.Vector3(Math.sin(this.orbit.yaw), 0, Math.cos(this.orbit.yaw));
        const k = this.orbit.distance * 0.0015;
        this.orbit.target.addScaledVector(right, -dx * k);
        this.orbit.target.addScaledVector(fwd, dy * k);
      }
      this._applyOrbit();
    };
    window.addEventListener('mouseup', up);
    window.addEventListener('mousemove', move);
    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.orbit.distance *= Math.exp(e.deltaY * 0.001);
      this.orbit.distance = Math.max(this.viewFrame.minDistance, Math.min(this.viewFrame.maxDistance, this.orbit.distance));
      this._applyOrbit();
    }, { passive: false });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    this._applyOrbit();
  }

  private _applyOrbit() {
    const o = this.orbit;
    this.camera.position.set(
      o.target.x + Math.sin(o.yaw) * Math.cos(o.pitch) * o.distance,
      o.target.y + Math.sin(o.pitch) * o.distance,
      o.target.z + Math.cos(o.yaw) * Math.cos(o.pitch) * o.distance,
    );
    this.camera.lookAt(o.target);
  }

  setCameraPreset(preset: string) {
    if (preset === 'topdown') { this.orbit.yaw = 0; this.orbit.pitch = Math.PI / 2 - 0.08; this.orbit.distance = this.viewFrame.distance * 1.05; }
    else if (preset === 'isometric') { this.orbit.yaw = Math.PI / 5; this.orbit.pitch = Math.PI / 3.3; this.orbit.distance = this.viewFrame.distance; }
    else if (preset === 'cinematic') { this.orbit.yaw = Math.PI / 3; this.orbit.pitch = Math.PI / 6; this.orbit.distance = this.viewFrame.distance * 1.12; }
    this.orbit.distance = Math.max(this.viewFrame.minDistance, Math.min(this.viewFrame.maxDistance, this.orbit.distance));
    this._applyOrbit();
  }

  zoomBy(factor: number) {
    this.orbit.distance = Math.max(
      this.viewFrame.minDistance,
      Math.min(this.viewFrame.maxDistance, this.orbit.distance * factor),
    );
    this._applyOrbit();
  }

  frameAll(preset = 'isometric') {
    this.orbit.target.copy(this.viewFrame.center);
    this.setCameraPreset(preset);
  }

  private _makeActor(a: SceneActor, style: string): THREE.Group {
    const spec = this.bspecs[a.loc];
    const bx = spec?.x ?? 0, bz = spec?.z ?? 0;
    const node = new THREE.Group();
    node.userData = { kind: 'actor', id: a.id };
    const mode = this.mode;
    const actorColor = mode.actor;
    const glow = !!mode.glowActor;

    if (style === 'card') {
      const c = document.createElement('canvas'); c.width = 256; c.height = 160;
      const g = c.getContext('2d')!;
      g.fillStyle = '#' + mode.bg.toString(16).padStart(6, '0'); g.fillRect(0, 0, 256, 160);
      g.strokeStyle = '#' + actorColor.toString(16).padStart(6, '0'); g.lineWidth = 2; g.strokeRect(1, 1, 254, 158);
      g.fillStyle = g.strokeStyle; g.font = '500 26px ui-sans-serif, system-ui, sans-serif'; g.fillText(a.name, 16, 46);
      g.font = '16px ui-sans-serif'; g.fillText(a.role, 16, 78); g.fillText(`${a.mbti} · ${a.age}`, 16, 108);
      const tex = new THREE.CanvasTexture(c); tex.anisotropy = 4;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
      sp.scale.set(50, 31, 1); sp.position.y = 36; node.add(sp);
    } else {
      const baseMat = () => new THREE.MeshStandardMaterial({
        color: actorColor, roughness: 0.85, flatShading: true,
        emissive: glow ? actorColor : 0x000000, emissiveIntensity: glow ? 0.45 : 0,
      });
      const body = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.2, 10, 12), baseMat());
      body.position.y = 5; body.castShadow = true; node.add(body);
      const head = new THREE.Mesh(new THREE.SphereGeometry(2.4, 12, 10), baseMat());
      head.position.y = 12; head.castShadow = true; node.add(head);
    }

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(4.5, 4.7, 32),
      new THREE.MeshBasicMaterial({ color: mode.ringColor ?? actorColor, side: THREE.DoubleSide, transparent: true, opacity: glow ? 0.85 : 0.45 }),
    );
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.25;
    node.add(ring); node.userData.ring = ring;

    const label = makeLabel(a.name, 0x1a237e, 0xffffff, 14);
    label.position.y = 20; label.renderOrder = 15; node.add(label);

    const seed = hashId(a.id);
    const jx = ((seed % 100) / 100 - 0.5) * (spec?.w ?? 10) * 0.35;
    const jz = (((seed * 7) % 100) / 100 - 0.5) * (spec?.d ?? 10) * 0.35;
    node.position.set(bx + jx, 0, bz + jz);
    node.userData.home = node.position.clone();
    return node;
  }

  setActorStyle(style: string) {
    for (const id in this.actors) this.actorGroup.remove(this.actors[id]);
    this.actors = {};
    this._data.actors.forEach(a => {
      const node = this._makeActor(a, style);
      this.actors[a.id] = node;
      this.actorGroup.add(node);
    });
    this._rebuildRels();
  }

  private _rebuildRels() {}

  private _animate(dt: number) {
    this._t += dt;
    for (const id in this.actors) {
      const n = this.actors[id];
      const ph = (id.charCodeAt(0) + (id.charCodeAt(1) || 0)) * 0.17;
      n.position.y = Math.sin(this._t * 1.4 + ph) * 0.25;
      if (n.userData.ring) (n.userData.ring as THREE.Mesh).material = new THREE.MeshBasicMaterial({
        color: this.mode.ringColor ?? this.mode.actor, side: THREE.DoubleSide, transparent: true,
        opacity: 0.35 + Math.sin(this._t * 1.7 + ph) * 0.1,
      });
    }
    if (this.focusRings) {
      this.focusRings.rotation.y += dt * 0.6;
      const s = 1 + Math.sin(this._t * 2.2) * 0.03;
      this.focusRings.scale.set(s, 1, s);
    }
    this.scene.traverse(obj => { if (obj instanceof THREE.Sprite) obj.quaternion.copy(this.camera.quaternion); });
  }

  focusOn(actorId: string) {
    const n = this.actors[actorId]; if (!n) return;
    if (this.focusRings) { this.scene.remove(this.focusRings); this.focusRings = null; }
    const group = new THREE.Group();
    group.position.copy(n.position).setY(0.3);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(9.4, 9.8, 64),
      new THREE.MeshBasicMaterial({ color: this.mode.ringColor ?? this.mode.actor, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }),
    );
    ring.rotation.x = -Math.PI / 2;
    group.add(ring);
    this.scene.add(group);
    this.focusRings = group;
    this.focusActorId = actorId;
    this.orbit.target.copy(n.position);
    this._applyOrbit();
  }

  private _pickActor(): string | null {
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const objs: THREE.Object3D[] = [];
    for (const id in this.actors) {
      this.actors[id].traverse(o => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
          o.userData.actorId = id;
          objs.push(o);
        }
      });
    }
    const hits = this.raycaster.intersectObjects(objs, false);
    return hits.length ? hits[0].object.userData.actorId : null;
  }

  setActorLocation(actorId: string, locId: string) {
    const n = this.actors[actorId];
    const spec = this.bspecs[locId];
    if (!n || !spec) return;
    const seed = hashId(actorId);
    const jx = ((seed % 100) / 100 - 0.5) * spec.w * 0.35;
    const jz = (((seed * 7) % 100) / 100 - 0.5) * spec.d * 0.35;
    const target = new THREE.Vector3(spec.x + jx, 0, spec.z + jz);
    const start = n.position.clone();
    const isFocused = actorId === this.focusActorId;
    const t0 = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / 1600);
      const k = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      n.position.x = start.x + (target.x - start.x) * k;
      n.position.z = start.z + (target.z - start.z) * k;
      if (isFocused) {
        this.orbit.target.copy(n.position);
        if (this.focusRings) this.focusRings.position.copy(n.position).setY(0.3);
        this._applyOrbit();
      }
      if (t < 1) requestAnimationFrame(step);
      else { n.userData.home = target.clone(); this._rebuildRels(); }
    };
    step();
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.mount) this.mount.removeChild(this.renderer.domElement);
  }
}
