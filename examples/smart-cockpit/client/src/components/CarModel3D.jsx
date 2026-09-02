import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Environment, useGLTF } from '@react-three/drei'
import { useEffect, useMemo, useRef } from 'react'

const DEFAULT_DIST = 11.91
const MIN_DIST = DEFAULT_DIST / 1.2
const WINDOW_DROP = 0.34

function nodeByName(nodes, names) {
  return names.map(name => nodes[name]).find(Boolean)
}

function cloneBaseTransform(node) {
  return {
    position: node.position.clone(),
    rotation: node.rotation.clone(),
  }
}

function resetTransform(node, base) {
  if (!node || !base) return
  node.position.copy(base.position)
  node.rotation.copy(base.rotation)
}

function openRatio(value) {
  const numeric = Number(value) || 0
  if (numeric <= 0) return 0
  if (numeric === 1) return 1
  return Math.max(0, Math.min(1, numeric / 100))
}

function prepareLightMaterials(nodes, matcher) {
  const materials = []
  Object.values(nodes).forEach(node => {
    if (!node?.material || !matcher(node.name)) return
    const material = node.material.clone()
    node.material = material
    materials.push(material)
  })
  return materials
}

function TeslaModel({ carState }) {
  const { scene } = useGLTF('/tesla-model-3.glb')
  const flashStartedAt = useRef(-10)
  const flashCount = useRef(0)
  const model = useMemo(() => {
    const clonedScene = scene.clone(true)
    const clonedNodes = {}
    const baseTransforms = new Map()
    clonedScene.traverse(child => {
      if (!child.name) return
      clonedNodes[child.name] = child
      baseTransforms.set(child, cloneBaseTransform(child))
    })

    const lower = name => name.toLowerCase()
    const flashMaterials = prepareLightMaterials(
      clonedNodes,
      name => (
        lower(name).includes('light')
        || lower(name).includes('indicator')
        || lower(name).includes('foglight')
      ),
    )
    return {
      scene: clonedScene,
      nodes: clonedNodes,
      baseTransforms,
      flashMaterials,
      windows: {
        windowFL: nodeByName(clonedNodes, ['door_lf_glass0_0', 'door_lf_glass.0_0']),
        windowFR: nodeByName(clonedNodes, ['door_rf_glass0_0', 'door_rf_glass.0_0']),
        windowRL: nodeByName(clonedNodes, ['door_lr_glass0_0', 'door_lr_glass.0_0']),
        windowRR: nodeByName(clonedNodes, ['door_rr_glass0_0', 'door_rr_glass.0_0']),
      },
      roof: nodeByName(clonedNodes, ['glass_glass1_0', 'glass_glass.1_0']),
      frontTrunk: nodeByName(clonedNodes, ['bonnet_dummy']),
      rearTrunk: nodeByName(clonedNodes, ['boot_dummy']),
    }
  }, [scene])

  useEffect(() => {
    Object.entries(model.windows).forEach(([key, node]) => {
      const ratio = openRatio(carState[key])
      resetTransform(node, model.baseTransforms.get(node))
      if (!node) return
      node.position.z -= ratio * WINDOW_DROP
      node.visible = ratio < 0.96
    })

    const sunroof = carState.sunroof
    resetTransform(model.roof, model.baseTransforms.get(model.roof))
    if (model.roof) {
      model.roof.visible = sunroof !== 1
      if (sunroof === 'vent' || sunroof === 'tilt') {
        model.roof.visible = true
        model.roof.rotation.x -= sunroof === 'tilt' ? 0.18 : 0.1
        model.roof.position.z += sunroof === 'tilt' ? 0.06 : 0.03
      }
    }

    resetTransform(model.frontTrunk, model.baseTransforms.get(model.frontTrunk))
    if (model.frontTrunk && carState.frontTrunk) {
      model.frontTrunk.rotation.x -= 0.78
      model.frontTrunk.position.z += 0.03
    }

    resetTransform(model.rearTrunk, model.baseTransforms.get(model.rearTrunk))
    if (model.rearTrunk && carState.rearTrunk) {
      model.rearTrunk.rotation.x += 0.82
      model.rearTrunk.position.z += 0.04
    }
  }, [carState, model])

  useFrame(({ clock }) => {
    if (carState.flashLightsCount !== flashCount.current) {
      flashCount.current = carState.flashLightsCount
      flashStartedAt.current = clock.getElapsedTime()
    }
    const elapsed = clock.getElapsedTime() - flashStartedAt.current
    const flashActive = elapsed >= 0 && elapsed < 1.25
    const pulse = flashActive ? Math.max(0, Math.sin(elapsed * Math.PI * 8)) : 0
    const headlightIntensity = carState.headlights ? 4 : 0
    model.flashMaterials.forEach(material => {
      const flashIntensity = pulse * 6
      material.color?.setHex(flashActive || carState.headlights ? 0xffcc00 : 0xaaaaaa)
      material.emissive?.setHex(flashActive || carState.headlights ? 0xffaa00 : 0x000000)
      material.emissiveIntensity = Math.max(headlightIntensity, flashIntensity)
      material.toneMapped = !(flashActive || carState.headlights)
    })
  })

  return (
    <group scale={0.008} position={[0, -0.2, 0]} rotation={[0, 2.2619, 0]}>
      <primitive object={model.scene} />
      {(carState.chargePort || carState.charging) && (
        <group position={[-1.08, -0.82, 0.28]}>
          <mesh>
            <sphereGeometry args={[0.08, 24, 24]} />
            <meshStandardMaterial
              color={carState.charging ? '#52ff9f' : '#65b7ff'}
              emissive={carState.charging ? '#15f47a' : '#2997ff'}
              emissiveIntensity={carState.charging ? 5 : 3}
              toneMapped={false}
            />
          </mesh>
          <pointLight
            color={carState.charging ? '#52ff9f' : '#65b7ff'}
            intensity={carState.charging ? 1.8 : 1}
            distance={1.2}
          />
        </group>
      )}
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
