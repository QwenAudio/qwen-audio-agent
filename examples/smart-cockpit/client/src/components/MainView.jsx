import VehiclePanel from './VehiclePanel'
import MapPanel from './MapPanel'

export default function MainView({ onOpenSettings }) {
  return (
    <div className="main-grid">
      <VehiclePanel variant="main" onOpenSettings={onOpenSettings} />
      <MapPanel />
    </div>
  )
}
