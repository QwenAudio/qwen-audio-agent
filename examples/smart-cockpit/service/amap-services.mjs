import {
  drivingRoute,
  geocode,
  getWeather,
  searchPlace,
} from './amap-client.mjs'

export function createAmapCockpitServices({
  search = searchPlace,
  encode = geocode,
  route = drivingRoute,
  forecast = getWeather,
} = {}) {
  return {
    async resolvePlace(name, city) {
      let place = null
      try {
        place = await search(name, city)
      } catch {}
      if (place?.location) return place.location
      return encode(name, city)
    },
    drivingRoute: route,
    weather: forecast,
  }
}
