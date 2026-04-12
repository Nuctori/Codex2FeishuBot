import { getBridgeContext, hasBridgeContext } from './context.js';

export type BridgeLocale = 'zh-CN' | 'en-US';

function normalizeBridgeLocale(raw: string | null | undefined): BridgeLocale {
  const value = String(raw || '').trim().toLowerCase();
  if (value.startsWith('en')) return 'en-US';
  return 'zh-CN';
}

export function getBridgeLocale(): BridgeLocale {
  const envLocale = process.env.CTI_BRIDGE_LOCALE
    || process.env.CTI_FEISHU_LOCALE
    || process.env.LC_ALL
    || process.env.LC_MESSAGES
    || process.env.LANG;

  if (!hasBridgeContext()) {
    return normalizeBridgeLocale(envLocale);
  }

  try {
    const store = getBridgeContext().store;
    const configured = store.getSetting('bridge_locale')
      || store.getSetting('bridge_feishu_locale')
      || envLocale;
    return normalizeBridgeLocale(configured);
  } catch {
    return normalizeBridgeLocale(envLocale);
  }
}

export function isZhBridgeLocale(): boolean {
  return getBridgeLocale() === 'zh-CN';
}

export function localizeText(english: string, chinese: string): string {
  return isZhBridgeLocale() ? chinese : english;
}
