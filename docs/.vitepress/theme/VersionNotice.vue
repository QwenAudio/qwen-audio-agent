<script setup>
import { computed } from 'vue'
import { useData, withBase } from 'vitepress'

const { lang } = useData()
const zh = computed(() => lang.value.startsWith('zh'))
</script>

<template>
  <aside class="manual-version" :aria-label="zh ? '文档版本' : 'Documentation version'">
    <span v-if="zh">
      本手册对应 <code>main</code> 开发版，部分功能尚未发布。
      <a href="https://github.com/QwenAudio/qwen-audio-agent/releases/latest">正式版下载与说明</a>
      · <a :href="withBase('/zh/getting-started/install#版本选择')">如何选择版本</a>
    </span>
    <span v-else>
      This manual follows development on <code>main</code>; some features are not released yet.
      <a href="https://github.com/QwenAudio/qwen-audio-agent/releases/latest">Stable downloads &amp; release notes</a>
      · <a :href="withBase('/getting-started/install#choosing-a-version')">Choosing a version</a>
    </span>
  </aside>
</template>
