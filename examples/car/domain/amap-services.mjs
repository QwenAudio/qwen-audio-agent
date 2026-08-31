import {
  drivingRoute,
  geocode,
  getWeather,
  searchPlace,
} from './amap-client.mjs'

export function createAmapCockpitServices() {
  return {
    async resolvePlace(name, city) {
      const place = await searchPlace(name, city)
      if (place?.location) return place.location
      return geocode(name, city)
    },
    drivingRoute,
    weather: getWeather,
  }
}
