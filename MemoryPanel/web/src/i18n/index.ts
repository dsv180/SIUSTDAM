/**
 * i18n initialization module
 *
 * - On first visit reads navigator.language (zh* → Chinese, ru* → Russian, else English)
 * - After a manual switch the choice is persisted to localStorage
 * - react-i18next's useTranslation automatically re-renders components on change
 * - English (en-US) is the base locale: any missing key falls back to English, never Chinese
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { zhCN } from './zh-CN';
import { enUS } from './en-US';
import { ruRU } from './ru-RU';

const STORAGE_KEY = 'tdai-memory.lang';

function detectInitialLanguage(): string {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (stored === 'zh-CN' || stored === 'en-US' || stored === 'ru-RU') return stored;
  } catch {
    // Storage can be unavailable under browser privacy or sandbox policies.
  }
  const nav = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
  if (nav.startsWith('zh')) return 'zh-CN';
  if (nav.startsWith('ru')) return 'ru-RU';
  return 'en-US';
}

export function changeLanguage(lang: string): void {
  void i18n.changeLanguage(lang);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, lang);
  } catch {
    // Persisting the preference is optional; the in-memory switch still stands.
  }
}

export function getCurrentLanguage(): string {
  return i18n.language || 'en-US';
}

i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    'en-US': { translation: enUS },
    'ru-RU': { translation: ruRU },
  },
  lng: detectInitialLanguage(),
  fallbackLng: 'en-US',
  interpolation: {
    escapeValue: false,
  },
  react: {
    useSuspense: false,
  },
});

export default i18n;
