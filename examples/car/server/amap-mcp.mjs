import { config } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(directory, '../.env.local') })

export {
  clearCallListener,
  drivingRoute,
  geocode,
  getWeather,
  searchPlace,
  setCallListener,
} from '../domain/amap-client.mjs'
