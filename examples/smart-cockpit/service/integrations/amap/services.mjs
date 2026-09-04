import {
  drivingRoute,
  geocode,
  getWeather,
  searchPlace,
  searchPlaces,
  searchNearbyPlaces,
} from './client.mjs'

export function createAmapCockpitServices({
  search = searchPlace,
  searchMany = searchPlaces,
  searchNearby = searchNearbyPlaces,
  encode = geocode,
  route = drivingRoute,
  forecast = getWeather,
  locate,
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
    searchPlaces: searchMany,
    searchNearbyPlaces: searchNearby,
    drivingRoute: route,
    weather: forecast,
    ...(typeof locate === 'function' ? { vehicleLocation: locate } : {}),
  }
}
