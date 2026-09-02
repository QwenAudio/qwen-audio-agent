import CarModel3D from './CarModel3D'
import VoiceDock from './VoiceDock'

export default function VehiclePanel({ onOpenSettings, carState, voiceMuted, voiceState, voiceProgress, voiceError, inputLevel, outputLevel, persona, onSelectPersona, onToggleVoiceMute }) {
  return (
    <aside className="vehicle-panel">
      <div className="speed-readout">
        <strong>0</strong>
        <span>KM/H</span>
      </div>
      <div className="car-stage">
        <CarModel3D carState={carState} />
      </div>
      <VoiceDock
        muted={voiceMuted}
        state={voiceState}
        progress={voiceProgress}
        error={voiceError}
        inputLevel={inputLevel}
        outputLevel={outputLevel}
        persona={persona}
        onSelectPersona={onSelectPersona}
        onToggleMute={onToggleVoiceMute}
        onOpenSettings={onOpenSettings}
      />
    </aside>
  )
}
