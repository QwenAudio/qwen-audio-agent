import { useMemo, useState } from 'react'
import flashBuyIcon from '../assets/taobao_flashbuy.png'

const CATEGORIES = [
  { id: 'food', label: '外卖', subtitle: '热餐快送' },
  { id: 'tea', label: '奶茶', subtitle: '顺路取送' },
]

const ITEMS = [
  { id: 'rice', category: 'food', name: '黑椒牛肉饭', shop: '云谷轻食', eta: '28分钟', price: 32, tag: '高蛋白' },
  { id: 'noodle', category: 'food', name: '番茄肥牛面', shop: '深夜面馆', eta: '31分钟', price: 29, tag: '热汤' },
  { id: 'salad', category: 'food', name: '鸡胸能量沙拉', shop: 'Fit Bowl', eta: '22分钟', price: 36, tag: '低脂' },
  { id: 'latte', category: 'tea', name: '茉莉轻乳茶', shop: '茶屿', eta: '18分钟', price: 18, tag: '少糖' },
  { id: 'milk', category: 'tea', name: '厚芋泥鲜奶', shop: '满杯日常', eta: '20分钟', price: 24, tag: '热饮' },
  { id: 'coffee', category: 'tea', name: '生椰拿铁', shop: 'M Coffee', eta: '16分钟', price: 22, tag: '冰饮' },
]

const STATUS_STEPS = ['已接单', '骑手取货中', '送往车旁']

export default function FlashBuyPanel({ flashBuyState = {}, onFlashBuyAction }) {
  const [localCategory, setLocalCategory] = useState('food')
  const [localCart, setLocalCart] = useState([])
  const [localOrder, setLocalOrder] = useState(null)

  const category = flashBuyState.category || localCategory
  const cart = flashBuyState.cartItems?.map(item => item.itemId || item.id) || localCart
  const order = flashBuyState.order || localOrder
  const results = flashBuyState.items?.length ? flashBuyState.items : ITEMS
  const visibleItems = useMemo(() => ITEMS.filter(item => item.category === category), [category])
  const displayedItems = flashBuyState.items?.length ? results : visibleItems
  const cartItems = useMemo(() => (
    flashBuyState.cartItems?.length
      ? flashBuyState.cartItems
      : cart.map(id => ITEMS.find(item => item.id === id)).filter(Boolean)
  ), [cart, flashBuyState.cartItems])
  const total = flashBuyState.preview?.total ?? flashBuyState.total ?? cartItems.reduce((sum, item) => sum + item.price * (item.quantity || 1), 0)
  const deliveryFee = flashBuyState.preview?.deliveryFee
  const statusText = flashBuyState.message || (order ? order.status || '骑手取货中' : '等待下单')
  const statusMeta = flashBuyState.preview
    ? `预计 ${flashBuyState.preview.eta} 送达 · 配送费 ¥${flashBuyState.preview.deliveryFee}`
    : order
      ? `订单 ${order.id || order.code} · 预计 ${order.eta} 到达`
      : '下单后展示骑手进度'

  const toggleCart = (id) => {
    if (onFlashBuyAction) {
      const item = displayedItems.find(row => row.id === id)
      onFlashBuyAction({ type: 'toggle_item', itemId: id, item })
      return
    }
    setLocalOrder(null)
    setLocalCart(prev => prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id])
  }

  const createOrder = () => {
    if (cartItems.length === 0) return
    if (onFlashBuyAction) {
      onFlashBuyAction({ type: 'confirm_order' })
      return
    }
    setLocalOrder({
      code: `SG${Math.floor(1000 + Math.random() * 9000)}`,
      eta: cartItems[0]?.eta || '25分钟',
      step: STATUS_STEPS[Math.min(STATUS_STEPS.length - 1, cartItems.length - 1)],
    })
  }

  const changeCategory = (id) => {
    if (onFlashBuyAction) {
      onFlashBuyAction({ type: 'set_category', category: id })
      return
    }
    setLocalCategory(id)
  }

  return (
    <section className="flashbuy-panel" aria-label="淘宝闪购">
      <div className="flashbuy-left">
        <div className="flashbuy-head">
          <span className="flashbuy-brand">
            <img src={flashBuyIcon} alt="" aria-hidden="true" />
            淘宝闪购
          </span>
          <strong>车旁即达</strong>
          <small>根据座舱位置模拟推荐外卖、奶茶与快送服务</small>
        </div>

        <div className="flashbuy-segment" role="tablist" aria-label="闪购分类">
          {CATEGORIES.map(item => (
            <button
              key={item.id}
              className={`flashbuy-segment-btn ${category === item.id ? 'is-active' : ''}`}
              onClick={() => changeCategory(item.id)}
              role="tab"
              aria-selected={category === item.id}
            >
              <span>{item.label}</span>
              <small>{item.subtitle}</small>
            </button>
          ))}
        </div>

        <div className="flashbuy-list" aria-label="商品列表">
          {displayedItems.map(item => {
            const selected = cart.includes(item.id)
            return (
              <button
                key={item.id}
                className={`flashbuy-item ${selected ? 'is-selected' : ''}`}
                onClick={() => toggleCart(item.id)}
              >
                <span className="flashbuy-item-art" aria-hidden="true">{category === 'food' ? '食' : '茶'}</span>
                <span className="flashbuy-item-main">
                  <strong>{item.name}</strong>
                  <small>{item.shop || item.shopName} · {item.eta}</small>
                </span>
                <span className="flashbuy-item-side">
                  <em>{item.tag}</em>
                  <strong>¥{item.price}</strong>
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <aside className="flashbuy-right" aria-label="订单摘要">
        <div className="flashbuy-location">
          <span>送达位置</span>
          <strong>阿里巴巴云谷园区 · P2 车位</strong>
          <small>模拟定位，骑手将送至车辆附近</small>
        </div>

        <div className="flashbuy-cart">
          <div className="flashbuy-cart-head">
            <strong>待下单</strong>
            <span>{cartItems.length} 件</span>
          </div>
          {cartItems.length === 0 ? (
              <div className="flashbuy-empty">{flashBuyState.status === 'searching' ? '正在查找附近可送商品' : '选择外卖或奶茶后在这里确认'}</div>
          ) : (
            cartItems.map(item => (
              <div className="flashbuy-cart-row" key={item.id || item.itemId}>
                <span>{item.name}{item.quantity > 1 ? ` x${item.quantity}` : ''}</span>
                <strong>¥{item.price * (item.quantity || 1)}</strong>
              </div>
            ))
          )}
          <div className="flashbuy-total">
            <span>{deliveryFee != null ? `合计 · 配送 ¥${deliveryFee}` : '合计'}</span>
            <strong>¥{total}</strong>
          </div>
          <button className="flashbuy-order-btn" disabled={cartItems.length === 0} onClick={createOrder}>
            模拟下单
          </button>
        </div>

        <div className={`flashbuy-status ${order || flashBuyState.preview ? 'is-active' : ''}`}>
          <span>配送状态</span>
          {order || flashBuyState.preview ? (
            <>
              <strong>{statusText}</strong>
              <small>{statusMeta}</small>
            </>
          ) : (
            <>
              <strong>{statusText}</strong>
              <small>{statusMeta}</small>
            </>
          )}
        </div>
      </aside>
    </section>
  )
}
