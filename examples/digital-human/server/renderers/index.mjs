import { attachDhavRenderer } from './dhav.mjs'
import { attachViduRenderer, viduAvailability } from './vidu.mjs'

// Explicit example-local registration. A commercial adapter can mint scoped
// RTC credentials here and deliver them to its browser counterpart; it does
// not need to convert its video into DHAV or change Gateway code.
export const rendererAdapters = Object.freeze({
  dhav: { attach: attachDhavRenderer },
  vidu: { attach: attachViduRenderer, maxMessageBytes: 6 * 1024 * 1024,
    config: ({ providerOptions }) => viduAvailability(providerOptions) },
})
