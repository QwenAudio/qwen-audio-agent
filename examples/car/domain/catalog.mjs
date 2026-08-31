export const SONGS = Object.freeze([
  Object.freeze({ id: 'sunny-day', title: '晴天', artist: '周杰伦', album: '叶惠美' }),
  Object.freeze({ id: 'common-jasmine-orange', title: '七里香', artist: '周杰伦', album: '七里香' }),
  Object.freeze({ id: 'rice-field', title: '稻香', artist: '周杰伦', album: '魔杰座' }),
  Object.freeze({ id: 'nocturne', title: '夜曲', artist: '周杰伦', album: '十一月的萧邦' }),
  Object.freeze({ id: 'simple-love', title: '简单爱', artist: '周杰伦', album: '范特西' }),
  Object.freeze({ id: 'blue-and-white-porcelain', title: '青花瓷', artist: '周杰伦', album: '我很忙' }),
])

export const FLASHBUY_CATALOG = Object.freeze([
  Object.freeze({ id: 'latte', shopId: 'tea-island', shopName: '茶屿', category: 'tea', name: '茉莉轻乳茶', eta: '18分钟', price: 18, tag: '少糖推荐', options: { sugar: ['无糖', '少糖', '正常糖'], temperature: ['冰', '常温', '热'], size: ['中杯', '大杯'] } }),
  Object.freeze({ id: 'milk', shopId: 'daily-cup', shopName: '满杯日常', category: 'tea', name: '厚芋泥鲜奶', eta: '20分钟', price: 24, tag: '热饮', options: { sugar: ['少糖', '正常糖'], temperature: ['常温', '热'], size: ['中杯', '大杯'] } }),
  Object.freeze({ id: 'coffee', shopId: 'm-coffee', shopName: 'M Coffee', category: 'tea', name: '生椰拿铁', eta: '16分钟', price: 22, tag: '冰饮', options: { sugar: ['无糖', '少糖'], temperature: ['冰', '热'], size: ['中杯', '大杯'] } }),
  Object.freeze({ id: 'rice', shopId: 'cloud-light', shopName: '云谷轻食', category: 'food', name: '黑椒牛肉饭', eta: '28分钟', price: 32, tag: '高蛋白', options: { flavor: ['正常', '少盐'], tableware: ['需要餐具', '无需餐具'] } }),
  Object.freeze({ id: 'noodle', shopId: 'night-noodle', shopName: '深夜面馆', category: 'food', name: '番茄肥牛面', eta: '31分钟', price: 29, tag: '热汤', options: { spice: ['不辣', '微辣'], tableware: ['需要餐具', '无需餐具'] } }),
  Object.freeze({ id: 'salad', shopId: 'fit-bowl', shopName: 'Fit Bowl', category: 'food', name: '鸡胸能量沙拉', eta: '22分钟', price: 36, tag: '低脂', options: { dressing: ['油醋汁', '凯撒酱'], tableware: ['需要餐具', '无需餐具'] } }),
])

export const DEFAULT_DELIVERY_ADDRESS = '阿里巴巴云谷园区 · P2 车位'
export const DEFAULT_ORIGIN = Object.freeze({
  name: '阿里巴巴云谷园区',
  location: '120.037239,30.318522',
  city: '杭州',
})
