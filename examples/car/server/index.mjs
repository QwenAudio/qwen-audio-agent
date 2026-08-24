import express from 'express'
import cors from 'cors'
import { config } from 'dotenv'
import { createServer } from 'http'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { chat, chatStream } from './agent.mjs'
import { builtinDomainCatalog, builtinSkillCatalog } from './skills/builtin/index.mjs'
import { clearMemory, readMemory, deleteMemory } from './memory.mjs'
import { clearHistory, loadHistory } from './context.mjs'
import { loadCustomSkillCatalog, deleteCustomSkill } from './tools/skill-manage.mjs'
import { attachVoiceRealtime } from './voice/realtime.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, '../.env.local') })

const app = express()
app.use(cors())
app.use(express.json())

const INITIAL_VEHICLE_STATE = {
  windowFL: 0,
  windowFR: 0,
  windowRL: 0,
  windowRR: 0,
  sunroof: 0,
  headlights: 0,
  ac: 1,
  acTemp: 25.0,
  acMode: 'cool',
  acFan: 3,
}

const vehicleStates = new Map()

function getVehicleState(clientId = 'default') {
  if (!vehicleStates.has(clientId)) {
    vehicleStates.set(clientId, { ...INITIAL_VEHICLE_STATE })
  }
  return vehicleStates.get(clientId)
}

function applyAgentActions(clientId, actions = []) {
  const vehicleState = getVehicleState(clientId)
  for (const action of actions) {
    if (action.type === 'car_control') {
      if (action.part === 'ac') {
        vehicleState.ac = action.state
        if (action.temperature != null) vehicleState.acTemp = action.temperature
        if (action.mode) vehicleState.acMode = action.mode
        if (action.fan != null) vehicleState.acFan = action.fan
      } else if (action.part in vehicleState) {
        vehicleState[action.part] = action.state
      }
    }
  }
}

function toClientHistory(history) {
  return history
    .filter((msg) => ['user', 'assistant'].includes(msg.role) && typeof msg.content === 'string' && msg.content.trim())
    .map((msg) => ({ role: msg.role, content: msg.content }))
}

app.post('/api/chat/stream', async (req, res) => {
  const { messages, sessionId, soul, strategy, thinking = true, clientId } = req.body
  const cid = clientId || sessionId || 'default'
  const vehicleState = getVehicleState(cid)

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' })
  }

  const userMessage = messages[messages.length - 1]?.content
  if (!userMessage) {
    return res.status(400).json({ error: 'last message must have content' })
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  try {
    await chatStream(userMessage, cid, vehicleState, soul, strategy || 0, thinking, cid, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`)

      if (event.type === 'done' && event.actions) applyAgentActions(cid, event.actions)
    })
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`)
  }

  res.end()
})

app.post('/api/chat', async (req, res) => {
  const { messages, sessionId, soul, strategy, thinking = true, clientId } = req.body
  const cid = clientId || sessionId || 'default'
  const vehicleState = getVehicleState(cid)

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' })
  }

  const userMessage = messages[messages.length - 1]?.content
  if (!userMessage) {
    return res.status(400).json({ error: 'last message must have content' })
  }

  try {
    const result = await chat(userMessage, cid, vehicleState, soul, strategy || 0, thinking, cid)

    if (result.actions) applyAgentActions(cid, result.actions)

    res.json({ content: result.content, actions: result.actions || [], debug: result.debug })
  } catch (err) {
    console.error('Agent error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/vehicle-state', (req, res) => {
  const cid = req.query.clientId || 'default'
  res.json(getVehicleState(cid))
})

app.get('/api/tool-catalog', (req, res) => {
  res.json({
    domains: builtinDomainCatalog,
    tools: builtinSkillCatalog,
  })
})

app.get('/api/history', async (req, res) => {
  const cid = req.query.clientId || 'default'
  const history = await loadHistory(cid)
  res.json(toClientHistory(history))
})

app.delete('/api/history', async (req, res) => {
  const cid = req.query.clientId || 'default'
  await clearHistory(cid)
  res.json([])
})

app.get('/api/memories', async (req, res) => {
  const cid = req.query.clientId || 'default'
  const items = await readMemory(cid)
  res.json(items)
})

app.delete('/api/memories/:index', async (req, res) => {
  const cid = req.query.clientId || 'default'
  await deleteMemory(cid, Number(req.params.index))
  const items = await readMemory(cid)
  res.json(items)
})

app.get('/api/skills', async (req, res) => {
  const cid = req.query.clientId || 'default'
  const skills = await loadCustomSkillCatalog(cid)
  res.json(skills)
})

app.get('/api/skills/:name', async (req, res) => {
  const cid = req.query.clientId || 'default'
  const name = decodeURIComponent(req.params.name)
  const { skillRun } = await import('./tools/skill-manage.mjs')
  const result = await skillRun.execute({ skill_name: name }, { clientId: cid })
  res.json({ name, content: result.result })
})

app.delete('/api/skills/:name', async (req, res) => {
  const cid = req.query.clientId || 'default'
  await deleteCustomSkill(cid, decodeURIComponent(req.params.name))
  const skills = await loadCustomSkillCatalog(cid)
  res.json(skills)
})

app.post('/api/reset', async (req, res) => {
  const cid = req.body.clientId || 'default'
  vehicleStates.set(cid, { ...INITIAL_VEHICLE_STATE })
  await clearMemory(cid)
  await clearHistory(cid)
  res.json({ ok: true })
})

const distPath = resolve(__dirname, '../react-app/dist')
app.use(express.static(distPath))
app.get('/{*splat}', (req, res) => {
  res.sendFile(resolve(distPath, 'index.html'))
})

const PORT = process.env.PORT || 3001
const server = createServer(app)
attachVoiceRealtime(server, { getVehicleState, applyAgentActions })

server.listen(PORT, () => {
  console.log(`Agent server running on http://localhost:${PORT}`)
  console.log(`Tools loaded, vehicle state tracking enabled`)
})
