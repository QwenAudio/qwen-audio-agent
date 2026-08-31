import { FLASHBUY_CATALOG } from './catalog.mjs'
import { clean, reportActivity, toolResult } from '../shared.mjs'

function inferCategory(query = '', category) {
  if (['food', 'tea'].includes(category)) return category
  if (/(外卖|吃|饭|面|沙拉|餐|牛肉|肥牛)/u.test(query)) return 'food'
  return 'tea'
}

function itemMatches(item, query = '') {
  if (!query) return true
  return [item.name, item.shopName, item.category, item.tag]
    .some(value => String(value || '').includes(query))
}

function normalizeItem(item) {
  return structuredClone(item)
}

function previewOrder(args, context) {
  const {
    cockpitId,
    onActivity,
    snapshot,
    store,
  } = context
  const before = snapshot()
  if (!before.flashbuy.cartItems.length) {
    return toolResult('购物车为空，请先选择商品', before, [])
  }
  reportActivity(onActivity, 'flashbuy', 'flashbuy_previewing', '正在试算订单')
  const state = store.update(cockpitId, ['flashbuy'], next => {
    const subtotal = next.flashbuy.cartItems.reduce((sum, row) => sum + row.price * row.quantity, 0)
    const deliveryFee = subtotal >= 35 ? 0 : 5
    const eta = next.flashbuy.cartItems
      .map(row => Number.parseInt(row.eta, 10))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0] || 25
    next.flashbuy.address = clean(args.address) || next.flashbuy.address
    next.flashbuy.status = 'awaiting_confirm'
    next.flashbuy.message = '请确认订单后下单'
    next.flashbuy.total = subtotal
    next.flashbuy.preview = {
      shopName: next.flashbuy.cartItems[0].shopName,
      items: structuredClone(next.flashbuy.cartItems),
      subtotal,
      deliveryFee,
      total: subtotal + deliveryFee,
      address: next.flashbuy.address,
      eta: `${eta}分钟`,
    }
  })
  const preview = state.flashbuy.preview
  const content = `订单预览：${preview.items.map(row => `${row.name}x${row.quantity}`).join('、')}，总价${preview.total}元，预计${preview.eta}送达`
  reportActivity(onActivity, 'flashbuy', 'flashbuy_preview_ready', '订单预览已生成')
  return toolResult(content, state, ['flashbuy'], { preview, requireConfirm: true })
}

function search(args, context) {
  const {
    cockpitId,
    onActivity,
    store,
  } = context
  const query = clean(args.query)
  const category = inferCategory(query, args.category)
  let items = FLASHBUY_CATALOG.filter(item => item.category === category && itemMatches(item, query))
  if (!items.length) items = FLASHBUY_CATALOG.filter(item => item.category === category)
  reportActivity(onActivity, 'flashbuy', 'flashbuy_searching', '正在查找附近可送商品')
  const state = store.update(cockpitId, ['flashbuy'], next => {
    Object.assign(next.flashbuy, {
      status: 'selecting',
      message: items.length ? '已找到附近可送商品' : '没有找到可送商品',
      query,
      category,
      items: items.map(normalizeItem),
      order: null,
    })
  })
  reportActivity(onActivity, 'flashbuy', 'flashbuy_results_ready', '已找到可送商品')
  return toolResult(`找到${items.length}个可送商品`, state, ['flashbuy'], { flashbuy: state.flashbuy })
}

function addToCart(args, context) {
  const {
    cockpitId,
    now,
    onActivity,
    snapshot,
    store,
  } = context
  let state = snapshot()
  if (!state.flashbuy.items.length) {
    search(args, context)
    state = snapshot()
  }
  const item = args.itemId
    ? state.flashbuy.items.find(row => row.id === args.itemId)
    : state.flashbuy.items.find(row => itemMatches(row, clean(args.query))) || state.flashbuy.items[0]
  if (!item) return toolResult('没有可加入购物车的商品', state, [])
  const quantity = Math.max(1, Number(args.quantity) || 1)
  reportActivity(onActivity, 'flashbuy', 'flashbuy_adding', '正在加入购物车')
  store.update(cockpitId, ['flashbuy'], next => {
    next.flashbuy.cartItems.push({
      ...normalizeItem(item),
      lineId: `${item.id}-${now()}`,
      quantity,
      selectedOptions: structuredClone(args.options || {}),
    })
    next.flashbuy.total = next.flashbuy.cartItems.reduce((sum, row) => sum + row.price * row.quantity, 0)
    next.flashbuy.status = 'cart_updated'
    next.flashbuy.message = '已更新购物车'
    next.flashbuy.order = null
    next.flashbuy.preview = null
  })
  const preview = previewOrder(args, context)
  return {
    ...preview,
    content: `已加入${item.name}。${preview.content}。请向用户确认是否下单。`,
  }
}

function updateCart(args, context) {
  const { cockpitId, onActivity, store } = context
  const quantity = Math.max(0, Number(args.quantity) || 0)
  const state = store.update(cockpitId, ['flashbuy'], next => {
    next.flashbuy.cartItems = next.flashbuy.cartItems
      .map(row => (
        row.lineId === args.lineId || row.id === args.itemId
          ? { ...row, quantity }
          : row
      ))
      .filter(row => row.quantity > 0)
    next.flashbuy.total = next.flashbuy.cartItems.reduce((sum, row) => sum + row.price * row.quantity, 0)
    next.flashbuy.status = next.flashbuy.cartItems.length ? 'cart_updated' : 'selecting'
    next.flashbuy.message = next.flashbuy.cartItems.length ? '已更新购物车' : '购物车已清空'
    next.flashbuy.preview = null
    next.flashbuy.order = null
  })
  reportActivity(onActivity, 'flashbuy', 'flashbuy_cart_updated', state.flashbuy.message)
  return toolResult(state.flashbuy.message, state, ['flashbuy'], { flashbuy: state.flashbuy })
}

export function executeFlashbuyTool(_name, args, context) {
  const {
    cockpitId,
    onActivity,
    random,
    snapshot,
    store,
  } = context
  const action = clean(args.action)
  const before = snapshot()
  if (action === 'search') return search(args, context)
  if (action === 'cancel_order') {
    const state = store.update(cockpitId, ['flashbuy'], next => {
      Object.assign(next.flashbuy, {
        status: 'cancelled',
        message: '已取消当前闪购流程',
        cartItems: [],
        total: 0,
        preview: null,
        order: null,
      })
    })
    reportActivity(onActivity, 'flashbuy', 'flashbuy_cancelled', '已取消闪购')
    return toolResult('已取消当前闪购流程', state, ['flashbuy'], { flashbuy: state.flashbuy })
  }
  if (action === 'add_to_cart') return addToCart(args, context)
  if (action === 'update_cart') return updateCart(args, context)
  if (action === 'preview_order') return previewOrder(args, context)
  if (action === 'confirm_order') {
    if (before.flashbuy.order) {
      return toolResult(`订单${before.flashbuy.order.id}已经提交，请勿重复下单`, before, [], {
        order: before.flashbuy.order,
        duplicate: true,
      })
    }
    if (!before.flashbuy.preview) {
      return toolResult('还没有可确认的订单，请先选择商品并预览订单', before, [])
    }
    if (args.confirmed !== true) {
      return toolResult('下单前需要用户明确确认', before, [], {
        requireConfirm: true,
        preview: before.flashbuy.preview,
      })
    }
    reportActivity(onActivity, 'flashbuy', 'flashbuy_ordering', '正在提交订单')
    const state = store.update(cockpitId, ['flashbuy'], next => {
      const preview = next.flashbuy.preview
      next.flashbuy.status = 'completed'
      next.flashbuy.message = '已完成下单'
      next.flashbuy.order = {
        id: `SG${Math.floor(1_000 + random() * 9_000)}`,
        status: '骑手取货中',
        eta: preview.eta,
        total: preview.total,
        address: preview.address,
        items: preview.items,
      }
      next.flashbuy.cartItems = []
      next.flashbuy.total = 0
      next.flashbuy.preview = null
    })
    reportActivity(onActivity, 'flashbuy', 'flashbuy_order_completed', '已完成下单')
    return toolResult(`已下单，订单${state.flashbuy.order.id}，预计${state.flashbuy.order.eta}送达`, state, ['flashbuy'], {
      order: state.flashbuy.order,
    })
  }
  throw new Error(`Unknown flashbuy action: ${action}`)
}
