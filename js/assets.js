// 游戏内图片资源路径辅助。资源来自原应用的 Assets/Team，经尺寸优化后放在 assets/。

import { cachedURL, portraitKey, shinyKey } from './img-store.js?v=126';

// 精灵立绘（Portrait 字段，如 JL_dimo.png）。
// 增量精灵 Portrait 为占位 '__wiki__'，立绘从 IndexedDB 缓存取。
export function portraitUrl(portrait, speciesId) {
  if (portrait === '__wiki__') return cachedURL(portraitKey(speciesId));
  return portrait ? `assets/portraits/${portrait}` : '';
}

// 已从 biligame Wiki 导入真实异色立绘的精灵 Id（assets/portraits_shiny/<Id>.png）。
// Wiki 暂未收录的精灵不在此集合，异色时回退原色立绘。
const SHINY_PORTRAIT_IDS = new Set([
  3010, 3039, 3062, 3063, 3064, 3069, 3075, 3076, 3077, 3083, 3084, 3085,
  3142, 3143, 3144, 3209, 3210, 3211, 3227, 3234, 3235, 3367, 3368, 3381,
  3406, 3407, 3412, 3487, 3488, 3489, 3490, 3491, 3499, 3506, 3507, 3659,
  3660, 3677, 3678, 3683, 3684, 3708, 3709, 3729, 3730, 3733, 3734, 3735,
  3736, 3737, 3743, 3744, 3745, 3784, 3785, 3805, 3806, 3807, 3808, 3809,
  3810, 3811, 3812, 3813, 3814, 3815, 3816, 3817, 3818, 3819, 3820, 3821,
]);

// 异色立绘：
// - 增量精灵（__wiki__）：从缓存取异色立绘，无缓存则回退缓存的原立绘；
// - 内置精灵：有真实 Wiki 立绘用真实文件，否则回退原色立绘。
export function shinyPortraitUrl(speciesId, normalPortrait) {
  const id = Number(speciesId);
  if (normalPortrait === '__wiki__') {
    return cachedURL(shinyKey(id)) || cachedURL(portraitKey(id));
  }
  return SHINY_PORTRAIT_IDS.has(id)
    ? `assets/portraits_shiny/${id}.png`
    : portraitUrl(normalPortrait, id);
}

// 元素属性图标（type_XX_icon.png）。元素 1（首领）无图标，返回空串走 fallback。
export function elementIconUrl(elementId) {
  const id = Number(elementId);
  if (id === 1 || id === 7) return '';
  return `assets/elements/type_${String(id).padStart(2, '0')}_icon.png`;
}

// 系别选择弹窗专用：从参考图二切出的手绘贴纸风徽章（含文字、透明底）
export function elementPickIconUrl(elementId) {
  const id = Number(elementId);
  if (id === 1 || id === 7) return '';
  return `assets/elements_pick2/t${id}.png?v=4`;
}

// 六维属性图标 stat_0..5
export function statIconUrl(statIndex) {
  return `assets/elements/stat_${Number(statIndex)}.png`;
}

// 性格增减箭头
export const natureUpUrl = 'assets/elements/nature_up.png';
export const natureDownUrl = 'assets/elements/nature_down.png';

// 带加载失败兜底的 <img> 标签
export function imgTag(src, cls = '', alt = '', fallback = '') {
  const fb = fallback
    ? `onerror="this.onerror=null;this.outerHTML='${fallback}'"`
    : 'onerror="this.style.visibility=\'hidden\'"';
  return `<img class="${cls}" src="${src}" alt="${alt}" loading="lazy" ${fb} />`;
}
