// 系别配色：取自游戏内 type_XX_icon.png 的圆底主色（base），
// 并人工调校出浅底（soft，卡片背景）与加深（deep，选中态）两档，
// 保证浅底上深色文字可读、加深底上白色文字清晰，整体温暖明亮。
// 字段：base 主色 / soft 浅背景 / deep 加深选中色。

export const ELEMENT_COLORS = {
  2:  { name: '普通', base: '#3c8cb4', soft: '#e3f0f8', deep: '#2b6f96' },
  3:  { name: '草',   base: '#4cbc74', soft: '#e2f4e9', deep: '#33965a' },
  4:  { name: '火',   base: '#dc541c', soft: '#fbe7dc', deep: '#b53f12' },
  5:  { name: '水',   base: '#64acfc', soft: '#e6f0fe', deep: '#3c84de' },
  6:  { name: '光',   base: '#4cc4fc', soft: '#e2f6fe', deep: '#1c9bd4' },
  8:  { name: '地',   base: '#9c7c44', soft: '#f1e9db', deep: '#7a5e2f' },
  9:  { name: '冰',   base: '#64acdc', soft: '#e6f1f8', deep: '#4284b6' },
  10: { name: '龙',   base: '#ec4c64', soft: '#fce4e9', deep: '#c42d48' },
  11: { name: '电',   base: '#e4cc04', soft: '#faf3cd', deep: '#a88700' },
  12: { name: '毒',   base: '#bc64e4', soft: '#f3e6fb', deep: '#933dc2' },
  13: { name: '虫',   base: '#9ccc24', soft: '#f0f7dc', deep: '#749f0e' },
  14: { name: '武',   base: '#fc9434', soft: '#feefdd', deep: '#d97012' },
  15: { name: '翼',   base: '#3cc4cc', soft: '#e0f5f7', deep: '#1d98a4' },
  16: { name: '萌',   base: '#fc7cb4', soft: '#fee9f2', deep: '#d94c8a' },
  17: { name: '幽',   base: '#9444ec', soft: '#efe2fc', deep: '#6e1ec6' },
  18: { name: '恶',   base: '#cc447c', soft: '#f9e3ee', deep: '#a2285c' },
  19: { name: '机械', base: '#24bca4', soft: '#ddf4ee', deep: '#0e8c76' },
  20: { name: '幻',   base: '#9cacfc', soft: '#eceffe', deep: '#7284dd' },
};

// 兜底（首领 id=1 等无图标情况）：暖棕中性色
const FALLBACK = { name: '默认', base: '#b9772b', soft: '#f3e4bd', deep: '#9a5e1c' };

export function elementColor(elementId) {
  return ELEMENT_COLORS[Number(elementId)] || FALLBACK;
}
