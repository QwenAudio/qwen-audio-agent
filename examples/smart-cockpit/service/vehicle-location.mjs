import { DEFAULT_ORIGIN } from './tools/navigation/catalog.mjs'

const [defaultLongitude, defaultLatitude] = DEFAULT_ORIGIN.location
  .split(',')
  .map(Number)

export const DEFAULT_VEHICLE_LOCATION = Object.freeze({
  name: DEFAULT_ORIGIN.name,
  city: '杭州市',
  district: '余杭区',
  address: '文一西路969号',
  longitude: defaultLongitude,
  latitude: defaultLatitude,
  coordinates: DEFAULT_ORIGIN.location,
  source: 'demo-default',
})

function clean(value) {
  return String(value || '').trim()
}

function coordinates(value) {
  const pair = clean(value?.coordinates || value?.location)
    .split(',')
    .map(Number)
  const longitude = Number(value?.longitude ?? value?.lng ?? pair[0])
  const latitude = Number(value?.latitude ?? value?.lat ?? pair[1])
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null
  return { longitude, latitude, coordinates: `${longitude},${latitude}` }
}

export function normalizeVehicleLocation(value) {
  if (!value || typeof value !== 'object') return null
  const point = coordinates(value)
  if (!point) return null
  return Object.freeze({
    name: clean(value.name),
    city: clean(value.city),
    district: clean(value.district),
    address: clean(value.address),
    ...point,
    source: clean(value.source) || 'vehicle',
  })
}

export function vehicleLocationText(location) {
  const details = [location.city, location.district, location.address]
    .filter(Boolean)
    .join('')
  if (location.name && details) return `${location.name}（${details}）`
  return location.name || details || '未知位置'
}
