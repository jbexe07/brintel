/*
 * Câmera de segurança articulada (arquivo .glb) que acompanha o mouse.
 *
 * O modelo tem duas peças: "base" (placa de parede + braço, FIXA) e
 * "head" (a câmera, que gira em cima do pescoço do suporte).
 *
 * Uso no HTML (o importmap vem ANTES do script):
 *   <div class="camera3d" data-camera3d data-model="models/camera.glb" aria-hidden="true"></div>
 *   <script type="importmap">
 *     { "imports": {
 *         "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
 *         "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
 *     } }
 *   </script>
 *   <script type="module" src="js/camera3d-glb.js"></script>
 *
 * O contêiner precisa ter altura definida no CSS.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

var host = document.querySelector('[data-camera3d]');
if (host) init(host);

function init(host) {
  // ---- Ajustes ----
  var MODEL_URL = host.getAttribute('data-model') || 'models/camera.glb';
  var TARGET_SIZE = 3.4;   // tamanho do maior lado do modelo na cena
  var REST_ANGLE = 0.9;    // quanto a base aponta para a esquerda (radianos). 0 = lente de frente para quem vê
  var AIM_RANGE = 1.0;     // para onde a lente aponta quando o mouse está longe (radianos, a partir de "de frente")
  var YAW_MIN = -1.0;      // limites do giro da cabeça em relação à base (radianos)
  var YAW_MAX = 1.3;
  var MAX_PITCH = 0.35;    // inclinação máxima para cima/baixo (~20°)
  var FOLLOW = 6;          // maior = acompanha o mouse mais rápido
  var IDLE_AFTER = 3000;   // ms sem mexer o mouse para voltar a "escanear"

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var touchOnly = window.matchMedia('(hover: none)').matches; // celular/tablet: sem mouse

  // ---- Renderizador (se o WebGL falhar, o contêiner recebe a classe sem-webgl) ----
  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch (err) {
    host.classList.add('sem-webgl');
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0); // fundo transparente
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  host.appendChild(renderer.domElement);

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
  var lookTarget = new THREE.Vector3(0, 0, 0);

  // Ambiente de estúdio: materiais PBR ficam escuros sem ele
  var pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  // Luzes extras: uma principal e uma de contorno azul
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1a2030, 0.3));
  var key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(3, 4, 5);
  scene.add(key);
  var rim = new THREE.DirectionalLight(0x4da3ff, 1.8);
  rim.position.set(-4, 2, -3);
  scene.add(rim);

  // Gira o conjunto para a lente apontar para a esquerda no repouso
  var holder = new THREE.Group();
  holder.rotation.y = -Math.PI / 2 - REST_ANGLE;
  scene.add(holder);

  // ---- Estado ----
  var head = null;          // peça que gira
  var yaw = 0.3;
  var pitch = 0;
  var mouse = { x: 0, y: 0 };
  var lastMove = -Infinity;
  var raf = 0;
  var last = 0;
  var inView = true;
  var tabVisible = !document.hidden;
  var loaded = false;

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  // ---- Carrega o modelo ----
  host.classList.add('carregando');
  new GLTFLoader().load(
    MODEL_URL,
    function (gltf) {
      var model = gltf.scene;
      head = model.getObjectByName('head');
      if (!head) {
        console.warn('[camera3d] O modelo não tem uma peça chamada "head"; a câmera não vai se mexer.');
      } else {
        head.rotation.order = 'YZX'; // gira de lado (pan) e depois inclina (tilt)
      }

      // mede, escala e centraliza no ponto (0, 0, 0)
      model.updateMatrixWorld(true);
      var box = new THREE.Box3().setFromObject(model);
      var size = box.getSize(new THREE.Vector3());
      var center = box.getCenter(new THREE.Vector3());
      var biggest = Math.max(size.x, size.y, size.z) || 1;
      var s = TARGET_SIZE / biggest;
      model.scale.setScalar(s);
      model.position.copy(center).multiplyScalar(-s);
      holder.add(model);

      loaded = true;
      host.classList.remove('carregando');
      resize();
      update();
    },
    undefined,
    function (err) {
      host.classList.remove('carregando');
      host.classList.add('sem-modelo');
      console.error('[camera3d] Não foi possível carregar "' + MODEL_URL + '". ' +
        'Confira o caminho do arquivo e se a página está aberta por um servidor (http://), e não por file://.', err);
    }
  );

  // Mouse relativo ao centro da câmera na tela: ela "olha" para onde o cursor está.
  window.addEventListener('pointermove', function (e) {
    if (e.pointerType !== 'mouse') return;
    var r = host.getBoundingClientRect();
    var cx = r.left + r.width / 2;
    var cyScreen = r.top + r.height / 2;
    mouse.x = clamp((e.clientX - cx) / (window.innerWidth / 2), -1, 1);
    mouse.y = clamp((e.clientY - cyScreen) / (window.innerHeight / 2), -1, 1);
    lastMove = performance.now();
  }, { passive: true });

  function applyPose() {
    if (!head) return;
    head.rotation.y = yaw;
    head.rotation.z = pitch;
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    var dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    var t = now / 1000;

    var idle = touchOnly || now - lastMove > IDLE_AFTER;
    var targetYaw, targetPitch;
    if (idle) {
      // sem mouse: varredura lenta, como uma câmera de monitoramento
      targetYaw = 0.3 + Math.sin(t * 0.5) * 0.5;
      targetPitch = Math.sin(t * 0.4) * 0.06;
    } else {
      // azimute desejado (0 = de frente para quem vê) convertido para o giro da cabeça
      targetYaw = clamp(mouse.x * AIM_RANGE + REST_ANGLE, YAW_MIN, YAW_MAX);
      targetPitch = clamp(-mouse.y * MAX_PITCH, -MAX_PITCH, MAX_PITCH);
    }

    var k = 1 - Math.exp(-FOLLOW * dt); // suavização independente da taxa de quadros
    yaw += (targetYaw - yaw) * k;
    pitch += (targetPitch - pitch) * k;
    applyPose();

    renderer.render(scene, camera);
  }

  function running() {
    return loaded && !reduced && inView && tabVisible;
  }

  function update() {
    if (running()) {
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    } else if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  function resize() {
    var w = host.clientWidth;
    var h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = w / h;
    // em telas estreitas, afasta a câmera para o modelo caber
    var k = Math.max(1, 0.9 / camera.aspect);
    camera.position.set(0, 1.1 * k, 9 * k);
    camera.lookAt(lookTarget);
    camera.updateProjectionMatrix();
    if (loaded && !running()) {
      applyPose();
      renderer.render(scene, camera);
    }
  }

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      inView = entries[0].isIntersecting;
      update();
    }).observe(host);
  }
  document.addEventListener('visibilitychange', function () {
    tabVisible = !document.hidden;
    update();
  });
  if ('ResizeObserver' in window) {
    new ResizeObserver(resize).observe(host);
  } else {
    window.addEventListener('resize', resize);
  }

  resize();
}
