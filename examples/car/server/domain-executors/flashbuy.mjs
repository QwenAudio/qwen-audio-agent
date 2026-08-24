const DEFAULT_ADDRESS = '阿里巴巴云谷园区 · P2 车位'

const CATALOG = [
  { id: 'latte', shopId: 'tea-island', shopName: '茶屿', category: 'tea', name: '茉莉轻乳茶', eta: '18分钟', price: 18, tag: '少糖推荐', options: { sugar: ['无糖', '少糖', '正常糖'], temperature: ['冰', '常温', '热'], size: ['中杯', '大杯'] } },
  { id: 'milk', shopId: 'daily-cup', shopName: '满杯日常', category: 'tea', name: '厚芋泥鲜奶', eta: '20分钟', price: 24, tag: '热饮', options: { sugar: ['少糖', '正常糖'], temperature: ['常温', '热'], size: ['中杯', '大杯'] } },
  { id: 'coffee', shopId: 'm-coffee', shopName: 'M Coffee', category: 'tea', name: '生椰拿铁', eta: '16分钟', price: 22, tag: '冰饮', options: { sugar: ['无糖', '少糖'], temperature: ['冰', '热'], size: ['中杯', '大杯'] } },
  { id: 'rice', shopId: 'cloud-light', shopName: '云谷轻食', category: 'food', name: '黑椒牛肉饭', eta: '28分钟', price: 32, tag: '高蛋白', options: { flavor: ['正常', '少盐'], tableware: ['需要餐具', '无需餐具'] } },
  { id: 'noodle', shopId: 'night-noodle', shopName: '深夜面馆', category: 'food', name: '番茄肥牛面', eta: '31分钟', price: 29, tag: '热汤', options: { spice: ['不辣', '微辣'], tableware: ['需要餐具', '无需餐具'] } },
  { id: 'salad', shopId: 'fit-bowl', shopName: 'Fit Bowl', category: 'food', name: '鸡胸能量沙拉', eta: '22分钟', price: 36, tag: '低脂', options: { dressing: ['油醋汁', '凯撒酱'], tableware: ['需要餐具', '无需餐具'] } },
]

const sessions = new Map()

function getSession(clientId = 'default') {
  if (!sessions.has(clientId)) {
    sessions.set(clientId, {
      query: '',
      category: 'tea',
      candidates: [],
      cart: [],
      preview: null,
      order: null,
      address: DEFAULT_ADDRESS,
    })
  }
  return sessions.get(clientId)
}

function inferCategory(query = '', category) {
  if (category && ['food', 'tea'].includes(category)) return category
  if (/(奶茶|饮料|咖啡|拿铁|茶|鲜奶|生椰)/.test(query)) return 'tea'
  if (/(外卖|吃|饭|面|沙拉|餐|牛肉|肥牛)/.test(query)) return 'food'
  return 'tea'
}

function normalizeItem(item) {
  return {
    id: item.id,
    shopId: item.shopId,
    shopName: item.shopName,
    category: item.category,
    name: item.name,
    eta: item.eta,
    price: item.price,
    tag: item.tag,
    options: item.options,
  }
}

function itemMatches(item, query = '') {
  if (!query) return true
  return [item.name, item.shopName, item.category, item.tag].some(value => value?.includes(query))
}

function searchItems({ query = '', category } = {}, context = {}) {
  const session = getSession(context.clientId)
  const nextCategory = inferCategory(query, category)
  let candidates = CATALOG.filter(item => item.category === nextCategory && itemMatches(item, query))
  if (candidates.length === 0) candidates = CATALOG.filter(item => item.category === nextCategory)
  session.query = query
  session.category = nextCategory
  session.candidates = candidates.map(normalizeItem)
  session.order = null
  return {
    result: `找到${session.candidates.length}个${nextCategory === 'tea' ? '奶茶饮品' : '外卖'}候选`,
    candidates: session.candidates,
    category: nextCategory,
    query,
  }
}

function resolveItem({ itemId, query = '' } = {}, session) {
  if (itemId) {
    const index = Number.parseInt(itemId, 10)
    if (Number.isFinite(index) && index > 0 && session.candidates[index - 1]) return session.candidates[index - 1]
    return CATALOG.find(item => item.id === itemId) || session.candidates.find(item => item.id === itemId)
  }
  const source = session.candidates.length ? session.candidates : CATALOG
  return source.find(item => itemMatches(item, query)) || source[0]
}

function addToCart({ itemId, query = '', quantity = 1, options = {} } = {}, context = {}) {
  const session = getSession(context.clientId)
  if (session.candidates.length === 0) searchItems({ query, category: inferCategory(query) }, context)
  const item = resolveItem({ itemId, query }, session)
  if (!item) return { result: '没有可加入购物车的商品', cart: session.cart }

  const line = {
    id: `${item.id}-${Date.now()}`,
    itemId: item.id,
    shopId: item.shopId,
    shopName: item.shopName,
    category: item.category,
    name: item.name,
    eta: item.eta,
    price: item.price,
    quantity: Math.max(1, Number(quantity) || 1),
    options,
  }
  session.cart = [...session.cart, line]
  session.order = null
  return {
    result: `已加入${line.name}`,
    item: line,
    cart: session.cart,
    total: session.cart.reduce((sum, row) => sum + row.price * row.quantity, 0),
  }
}

function updateCart({ lineId, itemId, quantity = 1 } = {}, context = {}) {
  const session = getSession(context.clientId)
  const qty = Math.max(0, Number(quantity) || 0)
  session.cart = session.cart
    .map(row => (row.id === lineId || row.itemId === itemId) ? { ...row, quantity: qty } : row)
    .filter(row => row.quantity > 0)
  session.order = null
  return {
    result: session.cart.length ? '购物车已更新' : '购物车已清空',
    cart: session.cart,
    total: session.cart.reduce((sum, row) => sum + row.price * row.quantity, 0),
  }
}

function previewOrder({ address } = {}, context = {}) {
  const session = getSession(context.clientId)
  if (address) session.address = address
  if (session.cart.length === 0) {
    return { result: '购物车为空，请先选择商品', preview: null }
  }
  const subtotal = session.cart.reduce((sum, row) => sum + row.price * row.quantity, 0)
  const deliveryFee = subtotal >= 35 ? 0 : 5
  const total = subtotal + deliveryFee
  const eta = session.cart
    .map(row => Number.parseInt(row.eta, 10))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0] || 25
  session.preview = {
    shopName: session.cart[0].shopName,
    items: session.cart,
    subtotal,
    deliveryFee,
    total,
    address: session.address,
    eta: `${eta}分钟`,
  }
  return {
    result: `订单预览：${session.preview.items.map(row => `${row.name}x${row.quantity}`).join('、')}，总价${total}元，预计${session.preview.eta}送达`,
    preview: session.preview,
  }
}

function confirmOrder({ confirmed = false } = {}, context = {}) {
  const session = getSession(context.clientId)
  if (!session.preview) previewOrder({}, context)
  if (!session.preview) return { result: '还没有可确认的订单', order: null }
  if (session.order) return { result: `订单${session.order.id}已经提交，请勿重复下单`, order: session.order, duplicate: true }
  if (!confirmed) return { result: '下单前需要用户明确确认', order: null, requireConfirm: true, preview: session.preview }

  const order = {
    id: `SG${Math.floor(1000 + Math.random() * 9000)}`,
    status: '骑手取货中',
    eta: session.preview.eta,
    total: session.preview.total,
    address: session.preview.address,
    items: session.preview.items,
  }
  session.order = order
  session.cart = []
  return {
    result: `已下单，订单${order.id}，预计${order.eta}送达`,
    order,
  }
}

function cancelOrder(_args = {}, context = {}) {
  const session = getSession(context.clientId)
  session.cart = []
  session.preview = null
  session.order = null
  return { result: '已取消当前闪购流程' }
}

function emitProgress(context, event) {
  if (context?.onProgress) context.onProgress({ domain: 'flashbuy', ...event })
}

function statusAction(status, message) {
  return { type: 'flashbuy', action: 'status', status, message }
}

function resultsAction(result) {
  return {
    type: 'flashbuy',
    action: 'results',
    status: 'selecting',
    category: result.category,
    query: result.query,
    items: result.candidates || [],
    message: result.candidates?.length ? '已找到附近可送商品' : '没有找到可送商品',
  }
}

function cartAction(result) {
  return {
    type: 'flashbuy',
    action: 'cart',
    status: 'cart_updated',
    items: result.cart || [],
    category: result.cart?.[0]?.category,
    total: result.total || 0,
    message: '已更新购物车',
  }
}

function previewAction(result) {
  return {
    type: 'flashbuy',
    action: 'preview',
    status: 'awaiting_confirm',
    preview: result.preview,
    category: result.preview?.items?.[0]?.category,
    requireConfirm: true,
    message: '请确认订单后下单',
  }
}

function completedAction(result) {
  return {
    type: 'flashbuy',
    action: 'completed',
    status: 'completed',
    order: result.order,
    message: '已完成下单',
  }
}

function sessionCompletedAction(order) {
  return {
    type: 'flashbuy',
    action: 'completed',
    status: 'completed',
    order,
    message: `订单${order.id}已经提交，请勿重复下单`,
  }
}

async function executeFlashBuy(params = {}, context = {}) {
  const actions = [{ type: 'flashbuy', action: 'open' }]
  const { action } = params

  if (action === 'cancel_order') {
    emitProgress(context, { stage: 'flashbuy_cancelled', message: '已取消闪购', speakPolicy: 'always' })
    const result = cancelOrder({}, context)
    actions.push({ type: 'flashbuy', action: 'cancelled', status: 'cancelled', message: result.result })
    return { result: result.result, actions }
  }

  if (action === 'search') {
    emitProgress(context, { stage: 'flashbuy_searching', message: '正在查找附近可送商品', speakPolicy: 'always' })
    actions.push(statusAction('searching', '正在查找附近可送商品'))
    const result = searchItems(params, context)
    emitProgress(context, { stage: 'flashbuy_results_ready', message: '已找到可送商品', speakPolicy: 'silent' })
    actions.push(resultsAction(result))
    return {
      result: `${result.result}：${result.candidates.map(item => `${item.name}，${item.shopName}，${item.price}元，${item.eta}`).join('；')}`,
      actions,
    }
  }

  if (action === 'add_to_cart') {
    if (!params.itemId) {
      emitProgress(context, { stage: 'flashbuy_searching', message: '正在查找附近可送商品', speakPolicy: 'always' })
      actions.push(statusAction('searching', '正在查找附近可送商品'))
      const search = searchItems(params, context)
      actions.push(resultsAction(search))
    }
    emitProgress(context, { stage: 'flashbuy_adding', message: '正在加入购物车', speakPolicy: 'if_slow' })
    actions.push(statusAction('cart_updating', '正在加入购物车'))
    const cart = addToCart(params, context)
    actions.push(cartAction(cart))
    emitProgress(context, { stage: 'flashbuy_previewing', message: '正在试算订单', speakPolicy: 'always' })
    actions.push(statusAction('previewing', '正在试算订单'))
    const preview = previewOrder(params, context)
    if (preview.preview) actions.push(previewAction(preview))
    return {
      result: `${cart.result}。${preview.result}。请向用户确认是否下单。`,
      actions,
    }
  }

  if (action === 'update_cart') {
    emitProgress(context, { stage: 'flashbuy_cart_updating', message: '正在更新购物车', speakPolicy: 'if_slow' })
    actions.push(statusAction('cart_updating', '正在更新购物车'))
    const cart = updateCart(params, context)
    actions.push(cartAction(cart))
    return { result: cart.result, actions }
  }

  if (action === 'preview_order') {
    const session = getSession(context?.clientId)
    if (session.cart.length === 0) {
      actions.push(statusAction('selecting', '请先选择商品后再下单'))
      return { result: '购物车为空，请先选择商品', actions }
    }

    emitProgress(context, { stage: 'flashbuy_previewing', message: '正在试算订单', speakPolicy: 'always' })
    actions.push(statusAction('previewing', '正在试算订单'))
    const preview = previewOrder(params, context)
    if (preview.preview) actions.push(previewAction(preview))
    return { result: `${preview.result}。请向用户确认是否下单。`, actions }
  }

  if (action === 'confirm_order') {
    const session = getSession(context?.clientId)
    if (session.order) {
      actions.push(sessionCompletedAction(session.order))
      return { result: `订单${session.order.id}已经提交，请勿重复下单`, actions }
    }

    if (!session.preview) {
      if (session.cart.length > 0) {
        emitProgress(context, { stage: 'flashbuy_previewing', message: '正在试算订单', speakPolicy: 'always' })
        actions.push(statusAction('previewing', '正在试算订单'))
        const preview = previewOrder(params, context)
        if (preview.preview) actions.push(previewAction(preview))
        return { result: `${preview.result}。请向用户确认是否下单。`, actions }
      }

      actions.push(statusAction('selecting', '请先选择商品后再下单'))
      return { result: '还没有可确认的订单，请先选择商品并预览订单', actions }
    }

    if (!params.confirmed) {
      actions.push(previewAction({ preview: session.preview }))
      return { result: '下单前需要用户明确确认', actions }
    }

    emitProgress(context, { stage: 'flashbuy_ordering', message: '正在提交订单', speakPolicy: 'always' })
    actions.push(statusAction('ordering', '正在提交订单'))
    const result = confirmOrder(params, context)
    if (result.duplicate && result.order) {
      actions.push(sessionCompletedAction(result.order))
    } else if (result.order) {
      emitProgress(context, { stage: 'flashbuy_order_completed', message: '已完成下单', speakPolicy: 'silent' })
      actions.push(completedAction(result))
    } else if (result.preview) {
      actions.push(previewAction(result))
    }
    return { result: result.result, actions }
  }

  return { result: '未知闪购操作', actions }
}

export default {
  'flashbuy.run': executeFlashBuy,
}
