import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { App as CapacitorApp } from '@capacitor/app'
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerCameraDirection,
  CapacitorBarcodeScannerScanOrientation,
  CapacitorBarcodeScannerTypeHint,
} from '@capacitor/barcode-scanner'
import { CapacitorHttp } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import {
  MOBILE_DEVICE_ID_KEY,
  MOBILE_GATEWAY_PROFILE_KEY,
  parseMobileGatewayProfile,
} from './mobile-profile.js'
import { randomUUID } from '../../shared/runtime-crypto.mjs'

export async function loadMobileGatewayProfile() {
  return parseMobileGatewayProfile(await SecureStorage.get(MOBILE_GATEWAY_PROFILE_KEY))
}

export async function saveMobileGatewayProfile(profile) {
  await SecureStorage.set(MOBILE_GATEWAY_PROFILE_KEY, profile)
}

export async function removeMobileGatewayProfile() {
  await SecureStorage.remove(MOBILE_GATEWAY_PROFILE_KEY)
}

export async function mobileDeviceId() {
  const current = await Preferences.get({ key: MOBILE_DEVICE_ID_KEY })
  if (current.value) return current.value
  const value = `mobile_${randomUUID()}`
  await Preferences.set({ key: MOBILE_DEVICE_ID_KEY, value })
  return value
}

export async function mobilePairingRequest(url, data) {
  return CapacitorHttp.post({
    url,
    data,
    headers: { 'Content-Type': 'application/json' },
    connectTimeout: 10_000,
    readTimeout: 10_000,
  })
}

export async function scanGatewayInvitation() {
  const result = await CapacitorBarcodeScanner.scanBarcode({
    hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
    cameraDirection: CapacitorBarcodeScannerCameraDirection.BACK,
    scanOrientation: CapacitorBarcodeScannerScanOrientation.ADAPTIVE,
    scanInstructions: '扫描电脑端显示的 Gateway 配对码',
    cancelButtonAccessibilityLabel: '取消扫描',
  })
  return String(result.ScanResult || '').trim()
}

export async function mobileLaunchUrl() {
  return (await CapacitorApp.getLaunchUrl())?.url || ''
}

export function onMobileUrlOpen(listener) {
  let handle
  let disposed = false
  CapacitorApp.addListener('appUrlOpen', event => listener(event.url)).then(value => {
    if (disposed) return value.remove()
    handle = value
  })
  return () => {
    disposed = true
    handle?.remove()
  }
}
