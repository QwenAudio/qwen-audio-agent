'use strict'

// Importing the extension is safe in a preflight; native modules are loaded
// only when the Gateway's isolated media worker calls this factory.
module.exports = {
  apiVersion: 1,
  loadNative() {
    return { rtc: require('@roamhq/wrtc'), sharp: require('sharp') }
  },
}
