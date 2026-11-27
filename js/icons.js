// 魔法主题内联 SVG 图标。currentColor 跟随文字颜色，可在任意位置复用。
// 风格：圆润描边、童趣，配合羊皮纸主题。

const wrap = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const ICONS = {
  // 魔杖：斜棒 + 顶端星星 + 闪光
  wand: wrap(`
    <path d="M5 19 14.5 9.5" />
    <path d="M14.5 9.5 16 5l4.5 1.5L19 11l-4.5-1.5Z" fill="currentColor" stroke="none" opacity="0.9"/>
    <path d="M19 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8.7 1.8-.7Z" fill="currentColor" stroke="none"/>
    <path d="M6.5 4.5l.5 1.2 1.2.5-1.2.5L6.5 8l-.5-1.3L4.8 6.2l1.2-.5Z" fill="currentColor" stroke="none"/>
  `),
  // 咕噜球（精灵球）
  ball: wrap(`
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.6 12h16.8" />
    <circle cx="12" cy="12" r="2.6" fill="currentColor"/>
    <path d="M8.2 5.4a8.5 8.5 0 0 1 7.6 0" opacity="0.5"/>
  `),
  // 四角闪光星
  sparkle: wrap(`
    <path d="M12 3l1.9 6.1L20 11l-6.1 1.9L12 19l-1.9-6.1L4 11l6.1-1.9Z" fill="currentColor" stroke="none"/>
  `),
  // 弯月
  moon: wrap(`
    <path d="M19 13.5A7.5 7.5 0 1 1 10.5 5 6 6 0 0 0 19 13.5Z" fill="currentColor" stroke="none"/>
  `),
  // 羽毛笔
  quill: wrap(`
    <path d="M20 4c-7 0-12 4-13.5 12L4 20l4-2.5C16 16 20 11 20 4Z" />
    <path d="M9 15 17 7" />
    <path d="M4 20c1.5-1 3-1.5 4-2.5" />
  `),
  // 卷轴
  scroll: wrap(`
    <path d="M6 4h11a2 2 0 0 1 2 2v12a2 2 0 0 0 2 2H8a2 2 0 0 1-2-2Z" />
    <path d="M6 4a2 2 0 0 0-2 2v1" />
    <path d="M9 9h6M9 13h6" />
  `),
  // 心形（呼应角色身上的爱心）
  heart: wrap(`
    <path d="M12 20s-7-4.6-7-9.2A3.8 3.8 0 0 1 12 7.5 3.8 3.8 0 0 1 19 10.8C19 15.4 12 20 12 20Z" fill="currentColor" stroke="none"/>
  `),
  // 刷新：循环箭头（检查更新）
  refresh: wrap(`
    <path d="M20 12a8 8 0 1 1-2.34-5.66" />
    <path d="M20 3.5v4h-4" />
  `),
};

export function icon(name, extraClass = '') {
  const svg = ICONS[name] || '';
  return extraClass ? svg.replace('<svg', `<svg class="${extraClass}"`) : svg;
}

// 异色精灵标记：圆润四角星 + 环绕月牙轨道（贴纸式白色描边 + 柔和投影）。
// 形状取自用户提供的官方标记参考；填充色由外层 CSS 控制：
//   .shiny-off（未激活）星与月牙均为中性灰；
//   .shiny-on（激活）星星蓝、月牙黄。
const SHINY_STAR_PATH =
  'M20.59 2.71 L19.49 3.59 L18.82 4.90 L18.39 6.38 L18.11 7.93 L17.89 9.52 ' +
  'L17.70 11.12 L17.33 12.63 L16.95 14.13 L16.61 15.65 L16.23 17.16 L15.36 18.41 ' +
  'L14.40 19.62 L13.39 20.74 L12.33 21.67 L11.36 22.89 L10.40 24.11 L9.39 25.28 ' +
  'L8.70 26.63 L8.30 28.12 L8.67 29.63 L9.07 31.12 L10.14 31.99 L11.36 32.43 ' +
  'L12.59 32.87 L13.83 33.30 L15.20 33.34 L16.42 32.89 L17.64 32.41 L18.88 32.01 ' +
  'L20.02 31.30 L21.23 30.80 L22.39 30.15 L23.51 29.38 L24.66 28.72 L25.80 28.01 ' +
  'L26.88 27.11 L27.95 26.22 L29.10 25.53 L30.19 24.67 L31.20 23.57 L32.21 22.50 ' +
  'L33.30 21.65 L34.29 20.46 L35.25 19.25 L36.22 18.05 L37.22 16.86 L37.68 15.38 ' +
  'L37.12 14.25 L35.91 13.76 L34.65 13.41 L33.38 13.11 L32.10 12.83 L31.01 11.98 ' +
  'L30.04 10.76 L28.95 9.91 L28.11 8.62 L27.28 7.33 L26.27 6.16 L25.32 4.96 ' +
  'L24.35 3.72 L23.28 2.84 L21.96 2.70 L20.59 2.71 Z';

const SHINY_RING_PATH =
  'M39.35 6.67 L37.32 7.31 L37.64 9.33 L39.29 11.04 L40.06 13.39 L39.46 15.82 ' +
  'L38.39 18.02 L37.09 20.10 L35.51 22.03 L33.83 23.66 L32.18 25.35 L30.54 27.10 ' +
  'L28.80 28.55 L26.98 29.75 L25.20 31.08 L23.41 32.40 L21.56 33.50 L19.65 34.46 ' +
  'L17.75 35.43 L15.77 36.15 L13.79 36.89 L11.71 37.32 L9.63 37.79 L7.57 37.30 ' +
  'L5.97 35.39 L5.45 32.90 L3.52 32.96 L2.54 35.20 L2.18 37.74 L2.71 40.22 ' +
  'L4.05 42.20 L5.96 43.14 L8.04 43.60 L10.28 43.56 L12.36 43.12 L14.44 42.69 ' +
  'L16.43 41.98 L18.42 41.29 L20.37 40.46 L22.28 39.54 L24.21 40.47 L25.53 42.55 ' +
  'L27.13 44.42 L29.11 45.21 L31.00 44.51 L32.19 42.63 L32.85 40.23 L33.22 37.67 ' +
  'L33.59 35.12 L34.29 32.73 L35.19 30.47 L36.87 28.83 L38.43 26.85 L40.12 25.26 ' +
  'L41.51 23.23 L42.94 21.21 L44.11 19.06 L45.10 16.83 L45.85 14.47 L45.83 11.72 ' +
  'L45.15 9.33 L43.35 7.98 L41.42 7.09 L39.35 6.67 Z';

export const SHINY_WING = `<svg viewBox="0 0 48 48" class="shiny-wing" aria-hidden="true">
  <defs>
    <filter id="shinyDrop" x="-25%" y="-25%" width="150%" height="150%">
      <feDropShadow dx="0" dy="2.2" stdDeviation="2" flood-color="#9a8c66" flood-opacity="0.42"/>
    </filter>
  </defs>
  <g filter="url(#shinyDrop)"
     stroke="#fffdf6" stroke-width="3" stroke-linejoin="round" stroke-linecap="round">
    <path class="shiny-ring" d="${SHINY_RING_PATH}"/>
    <path class="shiny-star" d="${SHINY_STAR_PATH}"/>
  </g>
</svg>`;

export function shinyIcon(extraClass = '') {
  return extraClass ? SHINY_WING.replace('<svg', `<svg class="shiny-wing ${extraClass}"`) : SHINY_WING;
}
