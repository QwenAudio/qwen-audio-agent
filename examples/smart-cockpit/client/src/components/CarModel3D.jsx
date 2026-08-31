import { Canvas } from '@react-three/fiber'
import { OrbitControls, Environment, useGLTF } from '@react-three/drei'
import { useMemo } from 'react'

const DEFAULT_DIST = 11.91
const MIN_DIST = DEFAULT_DIST / 1.2

function TeslaModel({ carState }) {
  const { scene } = useGLTF('/tesla-model-3.glb')
  const model = useMemo(() => {
    const clonedScene = scene.clone(true)
    const clonedNodes = {}
    clonedScene.traverse(child => {
      clonedNodes[child.name] = child
    })

    const wFL = clonedNodes['door_lf_glass0_0']
    const wFR = clonedNodes['door_rf_glass0_0']
    const wRL = clonedNodes['door_lr_glass0_0']
    const wRR = clonedNodes['door_rr_glass0_0']
    const roof = clonedNodes['glass_glass1_0']
    if (wFL) wFL.visible = !carState.windowFL
    if (wFR) wFR.visible = !carState.windowFR
    if (wRL) wRL.visible = !carState.windowRL
    if (wRR) wRR.visible = !carState.windowRR
    if (roof) roof.visible = !carState.sunroof

    const headlightNames = [
      'chrome_Lights_head_l_right_front_light_0',
      'chrome_Lights_head_l_left_front_light_0',
      'chrome_foglight_r_foglight_r_0',
      'chrome_foglight_l_foglight_l_0',
      'aluminium_light_aluminium_light0_0',
      'foglights_r_foglight_r_0',
      'foglights_l_foglight_l_0',
    ]
    const on = !!carState.headlights
    headlightNames.forEach(name => {
      const mesh = clonedNodes[name]
      if (mesh && mesh.material) {
        const mat = mesh.material.clone()
        mesh.material = mat
        if (on) {
          mat.color?.setHex(0xffcc00)
          mat.emissive?.setHex(0xffaa00)
          mat.emissiveIntensity = 4
          mat.toneMapped = false
        } else {
          mat.color?.setHex(0xaaaaaa)
          mat.emissive?.setHex(0x000000)
          mat.emissiveIntensity = 0
          mat.toneMapped = true
        }
      }
    })
    return clonedScene
  }, [scene, carState])

  return (
    <group scale={0.008} position={[0, -0.2, 0]} rotation={[0, 2.2619, 0]}>
      <primitive object={model} />
    </group>
  )
}

export default function CarModel3D({ carState }) {
  return (
    <Canvas
      camera={{ position: [-0.23, 5.04, 10.80], fov: 38 }}
      style={{ width: '100%', height: '100%' }}
      shadows
    >
      <ambientLight intensity={0.8} />
      <directionalLight position={[5, 8, 3]} intensity={1.5} castShadow />
      <directionalLight position={[-4, 5, -3]} intensity={0.5} />

      <TeslaModel carState={carState} />

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.2, 0]} receiveShadow>
        <planeGeometry args={[20, 20]} />
        <shadowMaterial transparent opacity={0.1} />
      </mesh>

      <OrbitControls
        enablePan={false}
        enableZoom={true}
        minDistance={MIN_DIST}
        maxDistance={16}
        minPolarAngle={0.3}
        maxPolarAngle={Math.PI / 2.2}
        target={[0, -0.2, 0]}
      />

      <Environment preset="city" />
    </Canvas>
  )
}

useGLTF.preload('/tesla-model-3.glb')
