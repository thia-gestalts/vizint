import { BoxGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, WebGLRenderer } from 'three';

const scene = new Scene();
const camera = new PerspectiveCamera(45, 2, 0.1, 100);
camera.position.z = 3;
const cube = new Mesh(new BoxGeometry(), new MeshBasicMaterial({ color: 0x4682b4 }));
cube.rotation.set(0.4, 0.6, 0);
scene.add(cube);

const canvas = document.createElement('canvas');
const context = canvas.getContext('webgl2');
if (context) {
  const renderer = new WebGLRenderer({ canvas, context });
  renderer.setSize(320, 160);
  document.body.append(canvas);
  renderer.render(scene, camera);
} else {
  document.body.append('This 3D view requires WebGL 2.');
}
