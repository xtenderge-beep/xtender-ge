/** @type {import('tailwindcss').Config} */
module.exports = {
  // Сканируем все шаблоны (вкл. инлайновые <script> с литеральными классами) и
  // serviceTypes.js — там catalogColor хранит классы бейджей групп каталога.
  content: [
    './src/views/**/*.ejs',
    './src/config/serviceTypes.js',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '"Noto Sans Georgian"', 'sans-serif'],
        mono: ['"IBM Plex Mono"', '"Noto Sans Georgian"', 'ui-monospace', 'monospace'],
      },
    },
  },
  // Классы, которые в JS переключаются через classList.toggle(...) — в шаблонах они
  // есть как строковые литералы, но держим явный список на случай рефактора.
  safelist: [
    'bg-emerald-600', 'bg-white', 'text-white', 'text-stone-600',
    'border-emerald-600', 'border-stone-200',
    'bg-red-50', 'text-red-700', 'border-red-200', 'text-red-600',
    'bg-emerald-50', 'text-emerald-700', 'border-emerald-200', 'text-emerald-600',
    'rotate-180', 'hidden', 'flex',
  ],
};
