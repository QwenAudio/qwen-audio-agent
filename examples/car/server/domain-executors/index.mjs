import vehicleExecutors from './vehicle.mjs'
import navigationExecutors from './navigation.mjs'
import musicExecutors from './music.mjs'
import flashBuyExecutors from './flashbuy.mjs'
import weatherExecutors from './weather.mjs'
import webSearchExecutors from './web-search.mjs'

export const domainExecutorRegistry = {
  ...vehicleExecutors,
  ...navigationExecutors,
  ...musicExecutors,
  ...flashBuyExecutors,
  ...weatherExecutors,
  ...webSearchExecutors,
}
