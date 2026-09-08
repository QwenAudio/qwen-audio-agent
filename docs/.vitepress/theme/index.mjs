import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'
import VersionNotice from './VersionNotice.vue'
import './style.css'

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, {
    'doc-before': () => h(VersionNotice),
    'home-hero-actions-after': () => h(VersionNotice),
  }),
}
