export const FLASHBUY_CATALOG = Object.freeze([
  Object.freeze({ id: 'latte', shopId: 'tea-island', shopName: '茶屿', category: 'tea', name: '茉莉轻乳茶', eta: '18分钟', price: 18, tag: '少糖推荐', options: { sugar: ['无糖', '少糖', '正常糖'], temperature: ['冰', '常温', '热'], size: ['中杯', '大杯'] } }),
  Object.freeze({ id: 'milk', shopId: 'daily-cup', shopName: '满杯日常', category: 'tea', name: '厚芋泥鲜奶', eta: '20分钟', price: 24, tag: '热饮', options: { sugar: ['少糖', '正常糖'], temperature: ['常温', '热'], size: ['中杯', '大杯'] } }),
  Object.freeze({ id: 'coffee', shopId: 'm-coffee', shopName: 'M Coffee', category: 'tea', name: '生椰拿铁', eta: '16分钟', price: 22, tag: '冰饮', options: { sugar: ['无糖', '少糖'], temperature: ['冰', '热'], size: ['中杯', '大杯'] } }),
  Object.freeze({ id: 'rice', shopId: 'cloud-light', shopName: '云谷轻食', category: 'food', name: '黑椒牛肉饭', eta: '28分钟', price: 32, tag: '高蛋白', options: { flavor: ['正常', '少盐'], tableware: ['需要餐具', '无需餐具'] } }),
  Object.freeze({ id: 'noodle', shopId: 'night-noodle', shopName: '深夜面馆', category: 'food', name: '番茄肥牛面', eta: '31分钟', price: 29, tag: '热汤', options: { spice: ['不辣', '微辣'], tableware: ['需要餐具', '无需餐具'] } }),
  Object.freeze({ id: 'salad', shopId: 'fit-bowl', shopName: 'Fit Bowl', category: 'food', name: '鸡胸能量沙拉', eta: '22分钟', price: 36, tag: '低脂', options: { dressing: ['油醋汁', '凯撒酱'], tableware: ['需要餐具', '无需餐具'] } }),
])

export const DEFAULT_DELIVERY_ADDRESS = '阿里巴巴云谷园区 · P2 车位'
